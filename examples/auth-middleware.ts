// Middleware de autenticação/autorização do backend (Express).
// Valida a sessão Supabase de quem chama a API e restringe cada rota
// por role de plataforma e por clínica — nenhuma rota administrativa
// aceita requisição sem um token de sessão válido.

import { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { realtime: { transport: ws as any } }
)

export interface Profile {
  id: string
  role: string
  clinica_id: string | null
  ativo: boolean
}

export interface AuthedRequest extends Request {
  profile?: Profile
}

// Valida o Bearer token da sessão Supabase e carrega o profile (role + clinica_id).
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Token ausente' })

  const { data: userData, error } = await supabase.auth.getUser(token)
  if (error || !userData?.user) return res.status(401).json({ error: 'Token inválido' })

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, clinica_id, ativo')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (!profile || !profile.ativo) return res.status(403).json({ error: 'Usuário sem perfil ativo' })

  req.profile = profile as Profile
  next()
}

// Restringe a um conjunto de roles de plataforma (profiles.role).
export function requireRole(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.profile || !roles.includes(req.profile.role)) {
      return res.status(403).json({ error: 'Sem permissão' })
    }
    next()
  }
}

// Garante que o profile só acesse a clínica dele, a menos que seja admin/ambos.
// getClinicaId extrai o clinica_id alvo do request (param, body etc.).
export function requireClinicaAccess(getClinicaId: (req: AuthedRequest) => string | undefined) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const profile = req.profile!
    if (profile.role === 'admin' || profile.role === 'ambos') return next()

    const clinicaId = getClinicaId(req)
    if (clinicaId && profile.clinica_id === clinicaId) return next()

    return res.status(403).json({ error: 'Sem acesso a essa clínica' })
  }
}
