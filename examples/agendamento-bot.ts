// Máquina de estados do bot de agendamento via WhatsApp.
// Calcula horários realmente livres (cruza disponibilidade do
// profissional, pausa/almoço e agenda já ocupada), conduz a conversa
// em etapas até confirmar, e persiste o estado no banco — se o
// servidor reiniciar no meio da conversa, o paciente não perde o
// progresso.

import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { realtime: { transport: ws as any } }
)

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const SLOT_MIN = 30   // duração padrão de cada slot em minutos
const MAX_SLOTS = 5   // máximo de opções apresentadas ao usuário

interface Slot {
  profissional_id: string
  profissional_nome: string
  data: string       // YYYY-MM-DD
  hora: string       // HH:MM
  dia_label: string  // "Ter, 01/07"
}

type BotStep = 'nome' | 'slots' | 'confirmar'

interface AgendState {
  step: BotStep
  nome?: string
  paciente_id?: string
  slots?: Slot[]
  slot?: Slot
}

// Cache em memória + persistência no Supabase (sobrevive a restart do processo).
const states = new Map<string, AgendState>()

async function loadState(phone: string): Promise<AgendState | undefined> {
  const cached = states.get(phone)
  if (cached) return cached
  const { data } = await supabase.from('bot_estados').select('estado').eq('phone_wa', phone).maybeSingle()
  if (data?.estado) { states.set(phone, data.estado as AgendState); return data.estado as AgendState }
  return undefined
}

async function saveState(phone: string, clinicaId: string, state: AgendState): Promise<void> {
  states.set(phone, state)
  await supabase.from('bot_estados').upsert({ phone_wa: phone, clinica_id: clinicaId, estado: state, updated_at: new Date().toISOString() })
}

async function clearState(phone: string): Promise<void> {
  states.delete(phone)
  await supabase.from('bot_estados').delete().eq('phone_wa', phone)
}

// ── helpers ──────────────────────────────────────────────────────
const horaToMin = (h: string) => { const [hh, mm] = h.split(':').map(Number); return hh * 60 + mm }
const minToHora = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const buildList  = (slots: Slot[]) =>
  slots.map((s, i) => `${i + 1}️⃣ ${s.dia_label} às ${s.hora} — ${s.profissional_nome}`).join('\n')

const INTENT_RE = /agendar|quero marcar|marcar consult|quero atend|dispon[ií]v|quero vir|preciso de hora|posso agendar|como agend/
const CANCEL_RE = /cancelar|desistir|nao quero|sair|outro assunto/
const SIM_RE    = /^(sim|s|confirmo|ok|certo|isso|pode ser|tudo bem)/
const NAO_RE    = /^(n[aã]o|nao|nope|outr|mudar|voltar|escolher)/

// ── slot generation ───────────────────────────────────────────────
async function getAvailableSlots(clinicaId: string): Promise<Slot[]> {
  const amanha = new Date()
  amanha.setDate(amanha.getDate() + 1)
  amanha.setHours(0, 0, 0, 0)
  const limite   = new Date(amanha.getTime() + 6 * 86_400_000)
  const dataInicio = amanha.toISOString().slice(0, 10)
  const dataFim    = limite.toISOString().slice(0, 10)

  const { data: profs } = await supabase
    .from('profissionais').select('id, nome')
    .eq('clinica_id', clinicaId).eq('ativo', true)

  if (!profs?.length) return []

  const profIds = profs.map(p => p.id)

  const [{ data: disps }, { data: agendados }] = await Promise.all([
    supabase.from('disponibilidade').select('*').in('profissional_id', profIds),
    supabase.from('agendamentos')
      .select('profissional_id, data, hora')
      .eq('clinica_id', clinicaId)
      .neq('status', 'cancelado')
      .gte('data', dataInicio)
      .lte('data', dataFim),
  ])

  const ocupados = new Set(agendados?.map(a => `${a.profissional_id}|${a.data}|${a.hora}`) || [])
  const slots: Slot[] = []

  outer: for (const prof of profs) {
    const profDisps = disps?.filter(d => d.profissional_id === prof.id) || []

    for (let d = 0; d < 7; d++) {
      const date = new Date(amanha.getTime() + d * 86_400_000)
      const diaSemana = date.getDay()
      const dateStr   = date.toISOString().slice(0, 10)

      const disp = profDisps.find(dd => dd.dia_semana === diaSemana)
      if (!disp) continue

      let cur = horaToMin(disp.hora_inicio)
      const end        = horaToMin(disp.hora_fim)
      const pausaStart = disp.hora_inicio_pausa ? horaToMin(disp.hora_inicio_pausa) : null
      const pausaEnd   = disp.hora_fim_pausa   ? horaToMin(disp.hora_fim_pausa)   : null

      while (cur + SLOT_MIN <= end) {
        const hora = minToHora(cur)
        const emPausa = pausaStart !== null && pausaEnd !== null && cur >= pausaStart && cur < pausaEnd

        if (!emPausa && !ocupados.has(`${prof.id}|${dateStr}|${hora}`)) {
          const [, mes, dia] = dateStr.split('-')
          slots.push({ profissional_id: prof.id, profissional_nome: prof.nome, data: dateStr, hora, dia_label: `${DIAS[diaSemana]}, ${dia}/${mes}` })
          if (slots.length >= MAX_SLOTS) break outer
        }
        cur += SLOT_MIN
      }
    }
  }

  return slots
}

// ── state machine ─────────────────────────────────────────────────
export async function handleAgendamentoBot(
  phone: string,
  text: string,
  clinicaId: string,
  paciente: { id: string; nome: string } | null,
): Promise<string | null> {
  const norm = text.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const state = await loadState(phone)

  // Saída do fluxo a qualquer momento
  if (state && CANCEL_RE.test(norm)) {
    await clearState(phone)
    return 'Tudo bem! Se precisar agendar, é só falar. 😊'
  }

  // ── Sem fluxo ativo — detecta intenção ───────────────────────
  if (!state) {
    if (!INTENT_RE.test(norm)) return null   // deixa o Claude responder

    if (paciente) {
      // Paciente cadastrado: já tem nome, vai direto para os slots
      const slots = await getAvailableSlots(clinicaId)
      if (!slots.length) {
        return 'No momento não temos horários disponíveis nos próximos 7 dias. Entre em contato diretamente para mais opções. 😊'
      }
      await saveState(phone, clinicaId, { step: 'slots', nome: paciente.nome, paciente_id: paciente.id, slots })
      return `Olá, ${paciente.nome}! Aqui estão os horários disponíveis: 📅\n\n${buildList(slots)}\n\nDigite o número desejado, ou *cancelar* para sair.`
    }

    // Lead novo: pede nome primeiro
    await saveState(phone, clinicaId, { step: 'nome' })
    return 'Ótimo! Vamos agendar. 📅\n\nQual é o seu nome completo?'
  }

  // ── Passo 1: nome ─────────────────────────────────────────────
  if (state.step === 'nome') {
    const nome = text.trim()
    if (nome.length < 2 || nome.length > 80) return 'Por favor, informe seu nome completo.'

    const slots = await getAvailableSlots(clinicaId)
    if (!slots.length) {
      await clearState(phone)
      return 'No momento não temos horários disponíveis nos próximos 7 dias. Entre em contato diretamente para mais opções. 😊'
    }

    await saveState(phone, clinicaId, { step: 'slots', nome, slots })
    const primeiro = nome.split(' ')[0]
    return `Prazer, ${primeiro}! Aqui estão os horários disponíveis:\n\n${buildList(slots)}\n\nDigite o número desejado, ou *cancelar* para sair.`
  }

  // ── Passo 2: escolha de slot ──────────────────────────────────
  if (state.step === 'slots') {
    const num = parseInt(text.trim()) - 1
    if (isNaN(num) || !state.slots || num < 0 || num >= state.slots.length) {
      return `Por favor, escolha um número de 1 a ${state.slots?.length ?? MAX_SLOTS}.`
    }
    const slot = state.slots[num]
    await saveState(phone, clinicaId, { ...state, step: 'confirmar', slot })
    return (
      `Você escolheu:\n\n` +
      `📅 ${slot.dia_label} às ${slot.hora}\n` +
      `👨‍⚕️ ${slot.profissional_nome}\n\n` +
      `Confirma? Responda *sim* para confirmar ou *não* para escolher outro horário.`
    )
  }

  // ── Passo 3: confirmação ──────────────────────────────────────
  if (state.step === 'confirmar') {
    if (SIM_RE.test(norm)) {
      const slot = state.slot!
      const { error } = await supabase.from('agendamentos').insert({
        clinica_id:       clinicaId,
        paciente_id:      state.paciente_id ?? null,
        nome:             state.nome,
        phone_wa:         phone,
        data:             slot.data,
        hora:             slot.hora,
        tipo:             'consulta',
        status:           'agendado',
        profissional_id:  slot.profissional_id,
        lembrete_enviado: false,
      })

      await clearState(phone)

      if (error) {
        console.error('❌ Agendamento bot erro:', error.message)
        return 'Ocorreu um erro ao confirmar. Por favor, entre em contato diretamente. 😊'
      }

      return (
        `✅ Agendamento confirmado!\n\n` +
        `📅 ${slot.dia_label} às ${slot.hora}\n` +
        `👨‍⚕️ ${slot.profissional_nome}\n\n` +
        `Te esperamos! Vamos te lembrar no dia anterior. 😊`
      )
    }

    if (NAO_RE.test(norm)) {
      await saveState(phone, clinicaId, { ...state, step: 'slots', slot: undefined })
      return `Sem problema! Escolha outro horário:\n\n${buildList(state.slots!)}`
    }

    return 'Responda *sim* para confirmar ou *não* para escolher outro horário.'
  }

  return null
}
