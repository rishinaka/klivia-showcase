// Backend authentication/authorization middleware (Express).
// Validates the caller's Supabase session and restricts every route
// by platform role and by clinic — no administrative route accepts
// a request without a valid session token.

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
  clinic_id: string | null
  active: boolean
}

export interface AuthedRequest extends Request {
  profile?: Profile
}

// Validates the Supabase session Bearer token and loads the profile (role + clinic_id).
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Missing token' })

  const { data: userData, error } = await supabase.auth.getUser(token)
  if (error || !userData?.user) return res.status(401).json({ error: 'Invalid token' })

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, clinic_id, active')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (!profile || !profile.active) return res.status(403).json({ error: 'Inactive or missing profile' })

  req.profile = profile as Profile
  next()
}

// Restricts access to a set of platform roles (profiles.role).
export function requireRole(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.profile || !roles.includes(req.profile.role)) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    next()
  }
}

// Ensures the profile can only access its own clinic, unless it's admin/both.
// getClinicaId extracts the target clinic_id from the request (param, body, etc.).
export function requireClinicAccess(getClinicId: (req: AuthedRequest) => string | undefined) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const profile = req.profile!
    if (profile.role === 'admin' || profile.role === 'both') return next()

    const clinicId = getClinicId(req)
    if (clinicId && profile.clinic_id === clinicId) return next()

    return res.status(403).json({ error: 'No access to this clinic' })
  }
}
