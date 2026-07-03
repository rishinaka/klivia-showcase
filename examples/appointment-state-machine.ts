// WhatsApp appointment scheduling bot — state machine.
// Computes real open slots (crossing professional availability,
// lunch/break windows and already-booked appointments), drives the
// conversation through steps until confirmation, and persists its
// state in the database — if the server restarts mid-conversation,
// the patient doesn't lose progress.

import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { realtime: { transport: ws as any } }
)

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const SLOT_MIN = 30   // default slot duration in minutes
const MAX_SLOTS = 5   // max options shown to the user

interface Slot {
  professional_id: string
  professional_name: string
  date: string       // YYYY-MM-DD
  time: string       // HH:MM
  day_label: string  // "Tue, 07/01"
}

type BotStep = 'name' | 'slots' | 'confirm'

interface BookingState {
  step: BotStep
  name?: string
  patient_id?: string
  slots?: Slot[]
  slot?: Slot
}

// In-memory cache + Supabase persistence (survives a process restart).
const states = new Map<string, BookingState>()

async function loadState(phone: string): Promise<BookingState | undefined> {
  const cached = states.get(phone)
  if (cached) return cached
  const { data } = await supabase.from('bot_states').select('state').eq('phone', phone).maybeSingle()
  if (data?.state) { states.set(phone, data.state as BookingState); return data.state as BookingState }
  return undefined
}

async function saveState(phone: string, clinicId: string, state: BookingState): Promise<void> {
  states.set(phone, state)
  await supabase.from('bot_states').upsert({ phone, clinic_id: clinicId, state, updated_at: new Date().toISOString() })
}

async function clearState(phone: string): Promise<void> {
  states.delete(phone)
  await supabase.from('bot_states').delete().eq('phone', phone)
}

// ── helpers ──────────────────────────────────────────────────────
const timeToMin = (h: string) => { const [hh, mm] = h.split(':').map(Number); return hh * 60 + mm }
const minToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const buildList  = (slots: Slot[]) =>
  slots.map((s, i) => `${i + 1}️⃣ ${s.day_label} at ${s.time} — ${s.professional_name}`).join('\n')

const INTENT_RE = /book|schedule|appointment|available|slot|when can i/i
const CANCEL_RE = /cancel|never mind|other topic/i
const YES_RE    = /^(yes|y|confirm|ok|sure|sounds good)/i
const NO_RE     = /^(no|n|nope|other|change|back|pick)/i

// ── slot generation ───────────────────────────────────────────────
async function getAvailableSlots(clinicId: string): Promise<Slot[]> {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)
  const limit    = new Date(tomorrow.getTime() + 6 * 86_400_000)
  const startDate = tomorrow.toISOString().slice(0, 10)
  const endDate   = limit.toISOString().slice(0, 10)

  const { data: pros } = await supabase
    .from('professionals').select('id, name')
    .eq('clinic_id', clinicId).eq('active', true)

  if (!pros?.length) return []

  const proIds = pros.map(p => p.id)

  const [{ data: availability }, { data: booked }] = await Promise.all([
    supabase.from('availability').select('*').in('professional_id', proIds),
    supabase.from('appointments')
      .select('professional_id, date, time')
      .eq('clinic_id', clinicId)
      .neq('status', 'cancelled')
      .gte('date', startDate)
      .lte('date', endDate),
  ])

  const taken = new Set(booked?.map(a => `${a.professional_id}|${a.date}|${a.time}`) || [])
  const slots: Slot[] = []

  outer: for (const pro of pros) {
    const proAvailability = availability?.filter(d => d.professional_id === pro.id) || []

    for (let d = 0; d < 7; d++) {
      const date = new Date(tomorrow.getTime() + d * 86_400_000)
      const weekday  = date.getDay()
      const dateStr  = date.toISOString().slice(0, 10)

      const avail = proAvailability.find(dd => dd.weekday === weekday)
      if (!avail) continue

      let cur = timeToMin(avail.start_time)
      const end       = timeToMin(avail.end_time)
      const breakStart = avail.break_start ? timeToMin(avail.break_start) : null
      const breakEnd   = avail.break_end   ? timeToMin(avail.break_end)   : null

      while (cur + SLOT_MIN <= end) {
        const time = minToTime(cur)
        const onBreak = breakStart !== null && breakEnd !== null && cur >= breakStart && cur < breakEnd

        if (!onBreak && !taken.has(`${pro.id}|${dateStr}|${time}`)) {
          const [, month, day] = dateStr.split('-')
          slots.push({ professional_id: pro.id, professional_name: pro.name, date: dateStr, time, day_label: `${WEEKDAYS[weekday]}, ${day}/${month}` })
          if (slots.length >= MAX_SLOTS) break outer
        }
        cur += SLOT_MIN
      }
    }
  }

  return slots
}

// ── state machine ─────────────────────────────────────────────────
export async function handleSchedulingBot(
  phone: string,
  text: string,
  clinicId: string,
  patient: { id: string; name: string } | null,
): Promise<string | null> {
  const norm = text.trim().toLowerCase()
  const state = await loadState(phone)

  // Exit the flow at any point
  if (state && CANCEL_RE.test(norm)) {
    await clearState(phone)
    return "No problem! Just let us know if you'd like to book later. 😊"
  }

  // ── No active flow — detect intent ───────────────────────
  if (!state) {
    if (!INTENT_RE.test(norm)) return null   // let Claude reply

    if (patient) {
      // Existing patient: name is already known, go straight to slots
      const slots = await getAvailableSlots(clinicId)
      if (!slots.length) {
        return "We don't have any open slots in the next 7 days right now. Please contact us directly for other options. 😊"
      }
      await saveState(phone, clinicId, { step: 'slots', name: patient.name, patient_id: patient.id, slots })
      return `Hi, ${patient.name}! Here are the available times: 📅\n\n${buildList(slots)}\n\nType the number you'd like, or *cancel* to exit.`
    }

    // New lead: ask for name first
    await saveState(phone, clinicId, { step: 'name' })
    return "Great! Let's book your appointment. 📅\n\nWhat's your full name?"
  }

  // ── Step 1: name ─────────────────────────────────────────────
  if (state.step === 'name') {
    const name = text.trim()
    if (name.length < 2 || name.length > 80) return 'Please provide your full name.'

    const slots = await getAvailableSlots(clinicId)
    if (!slots.length) {
      await clearState(phone)
      return "We don't have any open slots in the next 7 days right now. Please contact us directly for other options. 😊"
    }

    await saveState(phone, clinicId, { step: 'slots', name, slots })
    const firstName = name.split(' ')[0]
    return `Nice to meet you, ${firstName}! Here are the available times:\n\n${buildList(slots)}\n\nType the number you'd like, or *cancel* to exit.`
  }

  // ── Step 2: slot choice ──────────────────────────────────
  if (state.step === 'slots') {
    const num = parseInt(text.trim()) - 1
    if (isNaN(num) || !state.slots || num < 0 || num >= state.slots.length) {
      return `Please pick a number from 1 to ${state.slots?.length ?? MAX_SLOTS}.`
    }
    const slot = state.slots[num]
    await saveState(phone, clinicId, { ...state, step: 'confirm', slot })
    return (
      `You picked:\n\n` +
      `📅 ${slot.day_label} at ${slot.time}\n` +
      `👨‍⚕️ ${slot.professional_name}\n\n` +
      `Confirm? Reply *yes* to confirm or *no* to pick another time.`
    )
  }

  // ── Step 3: confirmation ──────────────────────────────────
  if (state.step === 'confirm') {
    if (YES_RE.test(norm)) {
      const slot = state.slot!
      const { error } = await supabase.from('appointments').insert({
        clinic_id:        clinicId,
        patient_id:       state.patient_id ?? null,
        name:             state.name,
        phone:            phone,
        date:             slot.date,
        time:             slot.time,
        type:             'consultation',
        status:           'scheduled',
        professional_id:  slot.professional_id,
        reminder_sent:    false,
      })

      await clearState(phone)

      if (error) {
        console.error('❌ Scheduling bot error:', error.message)
        return 'Something went wrong confirming your appointment. Please contact us directly. 😊'
      }

      return (
        `✅ Appointment confirmed!\n\n` +
        `📅 ${slot.day_label} at ${slot.time}\n` +
        `👨‍⚕️ ${slot.professional_name}\n\n` +
        `See you then! We'll remind you the day before. 😊`
      )
    }

    if (NO_RE.test(norm)) {
      await saveState(phone, clinicId, { ...state, step: 'slots', slot: undefined })
      return `No problem! Pick another time:\n\n${buildList(state.slots!)}`
    }

    return 'Reply *yes* to confirm or *no* to pick another time.'
  }

  return null
}
