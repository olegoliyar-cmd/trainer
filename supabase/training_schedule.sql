-- ============================================================================
-- БЛОК 2: АВТОМАТИЗАЦІЯ ГРАФІКА ТРЕНУВАНЬ
--   clients.train_days — графік клієнта, напр. ["mon","wed","fri"] (задає тренер)
--   training_intents   — намір на конкретний тренувальний день:
--     am_notified     — тренеру вранці сказали «сьогодні тренування у X»
--     asked_at        — о 18:00 клієнту надіслали інлайн-кнопки «Ідеш?»
--     answer          — 'yes' | 'no' (натиск кнопки; callback_query у telegram-webhook)
--     night_notified  — о 21:00 тренеру відзвітували, що тренування не відбулось
-- ============================================================================
alter table public.clients
  add column if not exists train_days jsonb not null default '[]'::jsonb;

create table if not exists public.training_intents (
  id             uuid primary key default gen_random_uuid(),
  trainer_id     uuid not null references public.trainers(id) on delete cascade,
  client_id      uuid not null references public.clients(id)  on delete cascade,
  date           date not null,
  am_notified    boolean not null default false,
  asked_at       timestamptz,
  answer         text,
  answered_at    timestamptz,
  night_notified boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (client_id, date)
);
create index if not exists idx_ti_trainer on public.training_intents(trainer_id, date desc);

alter table public.training_intents enable row level security;
drop policy if exists ti_tenant on public.training_intents;
create policy ti_tenant on public.training_intents
  for all to authenticated
  using (trainer_id = public.current_trainer_id())
  with check (trainer_id = public.current_trainer_id());
