-- ============================================================================
-- ЛІЧИЛЬНИК AI-ВИКЛИКІВ (бюджетні стелі). Спільний для всіх AI-фіч:
--   kind: 'food' (AI-ввід їжі) | 'checkin' | майбутні.
-- Пише service_role з Edge Functions; клієнт напряму не читає.
-- ============================================================================
create table if not exists public.ai_usage (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients(id) on delete cascade,
  date       date not null,
  kind       text not null,
  calls      int  not null default 0,
  unique (client_id, date, kind)
);
alter table public.ai_usage enable row level security;   -- лише service_role
