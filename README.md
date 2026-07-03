# KlivIA

Sistema de recepção inteligente para clínicas — atendimento via WhatsApp com IA, agenda, prontuário e CRM, multi-tenant (várias clínicas na mesma instalação, dados isolados entre si).

> Este repositório é uma vitrine técnica. O produto real ([klivia-admin](#) + klivia-api) roda em produção mas fica em repositório privado — aqui estão a descrição do sistema e dois trechos de código representativos da arquitetura, sem prompts de IA, regras de negócio ou dado de cliente.

## O problema

Clínica pequena/média não tem recepcionista disponível 24h, e perde paciente que desiste de esperar resposta no WhatsApp. Contratar mais gente pra atendimento não escala com o fluxo de mensagem.

## O que o sistema faz

- **Recepção via WhatsApp com IA**: entende a intenção do paciente (dúvida, agendamento, cancelamento) e responde automaticamente; escala pra atendente humano quando o caso pede.
- **Agendamento pelo próprio WhatsApp**: o paciente marca consulta direto na conversa — o bot mostra horários realmente livres (cruza disponibilidade do profissional, pausa/almoço e agenda já ocupada) e confirma sem precisar de atendente.
- **Lembrete automático D-1** e **cancelamento pelo paciente** via WhatsApp.
- **Prontuário por atendimento**: anamnese, procedimento e observações ficam vinculados ao agendamento e ao histórico do paciente.
- **CRM interno**: histórico de conversa, notas internas, atribuição de atendente.
- **Multi-tenant real**: uma instalação atende várias clínicas. Cada uma só enxerga os próprios dados — reforçado por Row-Level Security no banco, não só por filtro na tela.
- **Painel administrativo** por clínica: agenda, equipe, horários, configurações, onboarding guiado.

## Stack

- **Backend**: Node.js + TypeScript, Express, Supabase (Postgres + Row-Level Security + realtime), Claude API (Anthropic) pro atendimento conversacional, UAZAPI como gateway de WhatsApp.
- **Frontend**: React + TypeScript, Vite.
- **Infra**: DigitalOcean, PM2, Nginx.

## Trechos de código

- [`examples/auth-middleware.ts`](./examples/auth-middleware.ts) — middleware de autenticação/autorização do backend: valida a sessão Supabase e restringe cada rota por role e por clínica.
- [`examples/agendamento-bot.ts`](./examples/agendamento-bot.ts) — máquina de estados do bot de agendamento via WhatsApp: calcula horários livres cruzando disponibilidade, pausa e agenda ocupada, conduz a conversa em etapas até confirmar, e persiste o estado (sobrevive a um restart do servidor no meio da conversa).

## Contato

Ricardo — [rishinaka.work@gmail.com](mailto:rishinaka.work@gmail.com)
