# KlivIA
### AI-powered WhatsApp Reception Platform for Healthcare Clinics

✅ Multi-tenant SaaS — real Row-Level Security, not just UI filtering
✅ AI conversational reception (WhatsApp)
✅ Self-service scheduling via chat — availability, breaks and conflicts checked in real time
✅ Automated D-1 reminders and patient-initiated cancellation
✅ Medical records tied to each appointment
✅ Internal CRM (conversation history, notes, staff assignment)
✅ Role-based authorization (platform role + per-clinic role)

> This repository showcases the architecture and engineering decisions behind a production healthcare SaaS. Sensitive business logic, AI prompts, and customer data remain private in the main repos (`klivia-admin`, `klivia-api`).

## The problem

Small and mid-size clinics can't staff 24h reception, and lose patients who give up waiting for a WhatsApp reply. Hiring more front-desk staff doesn't scale with message volume.

## Architecture

```
Patient (WhatsApp)
      │
      ▼
   UAZAPI  ──────────────► webhook
      │
      ▼
 Express API  ── auth/tenant middleware ──► Supabase (Postgres + RLS + Realtime)
      │                                            │
      ▼                                            ▼
 Claude API                              React Admin Panel
 (intent + reply)                        (per-clinic dashboard)
      │
      ▼
 Scheduling state machine
 (availability → confirm → book)
```

## What it does

- **AI reception via WhatsApp**: understands patient intent (question, scheduling, cancellation) and replies automatically; escalates to a human attendant when needed.
- **Self-service scheduling inside the chat**: the bot computes real open slots — crossing professional availability, lunch/break windows and already-booked appointments — and confirms without staff involvement.
- **Automated D-1 reminders** and **patient-initiated cancellation** over WhatsApp.
- **Medical records per appointment**: anamnesis, procedure and notes linked to the appointment and patient history.
- **Internal CRM**: conversation history, internal notes, staff assignment.
- **Real multi-tenancy**: one deployment serves several clinics. Each one only ever sees its own data — enforced by Postgres Row-Level Security, not just a screen-level filter.
- **Admin panel per clinic**: schedule, staff, working hours, configuration, guided onboarding.

## Highlights

- Production-ready architecture (DigitalOcean, PM2, Nginx)
- Multi-tenant SaaS with Postgres Row-Level Security
- Role-based authorization (platform role + per-clinic role)
- AI conversational workflow (Claude API)
- WhatsApp automation (UAZAPI)
- Stateful conversation flow that survives a server restart mid-conversation
- ~14 database tables, 11 REST endpoints — small, deliberate surface area, not over-engineered

## Stack

- **Backend**: Node.js + TypeScript, Express, Supabase (Postgres + Row-Level Security + Realtime), Claude API (Anthropic), UAZAPI as WhatsApp gateway.
- **Frontend**: React + TypeScript, Vite.
- **Infra**: DigitalOcean, PM2, Nginx.

## Code examples

- [`examples/tenant-security.ts`](./examples/tenant-security.ts) — backend auth/authorization middleware: validates the Supabase session and restricts every route by platform role and by clinic.
- [`examples/appointment-state-machine.ts`](./examples/appointment-state-machine.ts) — WhatsApp scheduling bot: computes real availability (crossing schedule, breaks and existing bookings), drives the conversation through steps to confirmation, and persists its state (survives a server restart mid-conversation).

## Contact

Ricardo — 20+ years building business-critical systems, currently focused on AI agents, backend architecture, SaaS platforms and automation.
[rishinaka.work@gmail.com](mailto:rishinaka.work@gmail.com)
