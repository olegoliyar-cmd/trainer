-- ============================================================================
-- БЛОК 4: ЩОДЕННИЙ ЗВІТ (КВІЗ) + тижневий/місячний зріз.
--   Ідея: тренування — лише одна складова. Клієнт щовечора тапає короткий
--   чек-лист (кроки/харчування/сон/режим/відновлення) → тренер бачить % виконання
--   і має аргумент для розмови «ти виконав 30% плану — тому й не росте».
--
-- КЛЮЧОВЕ: чек-лист КОНФІГУРОВАНИЙ (шаблон юзера — під турніки, треба й зал).
--   clients.report_config jsonb = {"items":[{key,label,type,...}]}
--   types: bool | choice | scale
--   days: ["mon","wed","fri"] — пункт показується лише в ці дні
--   weeklyGoal: N — ціль на тиждень (для скорингу)
-- ============================================================================
alter table public.clients
  add column if not exists report_config     jsonb,
  add column if not exists report_daily      boolean not null default false,
  add column if not exists report_asked_at   date,
  add column if not exists report_reminded_at date;

create table if not exists public.daily_reports (
  id         uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers(id) on delete cascade,
  client_id  uuid not null references public.clients(id)  on delete cascade,
  date       date not null,
  answers    jsonb not null default '{}'::jsonb,   -- {key: value}
  score      int  not null default 0,              -- % виконаних пунктів дня
  created_at timestamptz not null default now(),
  unique (client_id, date)
);
create index if not exists idx_reports_client on public.daily_reports(client_id, date desc);
create index if not exists idx_reports_trainer on public.daily_reports(trainer_id, date desc);

alter table public.daily_reports enable row level security;
drop policy if exists reports_tenant on public.daily_reports;
create policy reports_tenant on public.daily_reports
  for all to authenticated
  using (trainer_id = public.current_trainer_id())
  with check (trainer_id = public.current_trainer_id());

-- Дефолтний шаблон тренера (можна перевизначити на клієнті)
alter table public.trainers
  add column if not exists report_template jsonb;
