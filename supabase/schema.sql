-- ============================================================================
-- TRAINER SaaS — Supabase schema (мультитенант: усе тенантне має trainer_id)
-- Дзеркалить модель backend/store.mjs (EMPTY) 1-в-1, але реляційно:
--   • photos/measurements винесені в окремі таблиці (у mock вони жили в client.*)
--   • jsonb для структурованих полів (accent, pipeline, structure, sets, items…)
--   • trainer_id ДЕНОРМАЛІЗОВАНО на кожен тенантний рядок → проста й швидка RLS
-- Запускати ПЕРШИМ (потім policies.sql). Ідемпотентно (create if not exists).
-- ============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- updated_at автооновлення (за бажанням; created_at ставимо через default) -----
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ── TRAINERS ────────────────────────────────────────────────────────────────
-- owner → auth.users (Supabase Auth). Один тренер = один auth-акаунт.
-- slug → публічний тенант-ключ для клієнтського апу (?trainer=slug).
create table if not exists public.trainers (
  id                uuid primary key default gen_random_uuid(),
  owner             uuid references auth.users(id) on delete set null,
  slug              text unique not null,
  brand_name        text not null default 'FITCOACH',
  trainer_name      text not null default 'Тренер',
  photo_url         text,
  telegram_chat_url text,
  accent            jsonb,          -- {color, deep, faint, glow, ring}
  tg_chat_id        text,           -- Telegram chat тренера (куди слати сповіщення про тренування)
  notify_workouts   boolean default true, -- слати сповіщення «клієнт тренується»
  pipeline          jsonb,          -- [{key,label}]  стадії воронки
  exercise_groups   jsonb,          -- [{key,label}]  групи мʼязів
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_trainers_owner on public.trainers(owner);

-- ── CLIENTS ─────────────────────────────────────────────────────────────────
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  tg_user_id  text,               -- Telegram user id (привʼязка клієнта)
  name        text not null default 'Клієнт',
  sex         text, goal text, level text,
  weight      numeric, height numeric,
  status      text default 'invited',   -- invited | active | …
  segment     text default 'lead',
  stage       text default 'new',       -- ключ стадії воронки (trainers.pipeline)
  contact     text, source text,
  paid_until  date,
  plan_price  numeric,            -- щомісячна плата за ведення цього клієнта
  plan_currency text default 'USD', -- валюта плати (у кожного клієнта своя)
  profile     jsonb,              -- анкета: {equipment,days_per_week,motivation,injuries,health,trainer_notes}
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_clients_trainer on public.clients(trainer_id);
create index if not exists idx_clients_tg on public.clients(tg_user_id);

-- ── PROGRAMS (шаблони + персональні) ─────────────────────────────────────────
create table if not exists public.programs (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  name        text not null default 'Програма',
  description text default '',
  builtin_key text,               -- ключ вбудованої програми (повний UI у клієнті)
  is_template boolean not null default false,
  structure   jsonb,              -- {weeks, days:[{name,exercises:[{...,sets,reps}]}]}
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_programs_trainer on public.programs(trainer_id);

-- ── ASSIGNMENTS (поточна призначена програма клієнта) ────────────────────────
create table if not exists public.assignments (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  client_id   uuid not null references public.clients(id)  on delete cascade,
  program_id  uuid not null references public.programs(id) on delete cascade,
  assigned_at timestamptz not null default now()
);
create index if not exists idx_assignments_client on public.assignments(client_id);

-- ── WORKOUT_LOGS (клієнт логує → тренер бачить) ──────────────────────────────
create table if not exists public.workout_logs (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  client_id   uuid not null references public.clients(id)  on delete cascade,
  date        date not null,
  day_key     text, day_name text,
  exercise    text,
  sets        jsonb,              -- [{reps,weight}]
  created_at  timestamptz not null default now()
);
create index if not exists idx_wl_client_date on public.workout_logs(client_id, date);

-- ── NUTRITION_LOGS ───────────────────────────────────────────────────────────
create table if not exists public.nutrition_logs (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  client_id   uuid not null references public.clients(id)  on delete cascade,
  date        date not null,
  time        text,
  slot        text default 'meal',   -- meal | snack
  slot_idx    int  default 0,
  label       text,
  kind        text default 'text',   -- text | voice | photo
  text        text,
  photo       text,               -- dataURL/Storage-URL; тренер обнуляє при «перевірено»
  items       jsonb,              -- [{name,grams,kcal,protein,carbs,fat}]
  kcal        int, protein int, carbs int, fat int,
  reviewed    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_nut_client_date on public.nutrition_logs(client_id, date);

-- ── CLIENT_MEASUREMENTS (у mock жили в client.measurements) ──────────────────
create table if not exists public.client_measurements (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  client_id   uuid not null references public.clients(id)  on delete cascade,
  date        date not null,
  weight numeric, height numeric, waist numeric, chest numeric,
  hip numeric, arm numeric, thigh numeric, bodyfat numeric,
  created_at  timestamptz not null default now()
);
create index if not exists idx_meas_client_date on public.client_measurements(client_id, date);

-- ── CLIENT_PHOTOS (фото прогресу; pose = front|left|right|back) ──────────────
create table if not exists public.client_photos (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  client_id   uuid not null references public.clients(id)  on delete cascade,
  date        date not null,
  pose        text default 'front',
  note        text,
  thumb       text,               -- dataURL зараз; згодом → Storage-URL
  created_at  timestamptz not null default now()
);
create index if not exists idx_photos_client on public.client_photos(client_id);

-- ── PAYMENTS ─────────────────────────────────────────────────────────────────
create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  trainer_id   uuid not null references public.trainers(id) on delete cascade,
  client_id    uuid not null references public.clients(id)  on delete cascade,
  amount       numeric,
  currency     text default 'USD',
  date         date not null default (now()::date),
  period_until date,
  method       text, coupon_code text, note text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_pay_trainer on public.payments(trainer_id);
create index if not exists idx_pay_client on public.payments(client_id);

-- ── COUPONS ──────────────────────────────────────────────────────────────────
create table if not exists public.coupons (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  code        text not null,
  kind        text default 'percent',   -- percent | amount
  value       numeric default 0,
  note        text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists idx_coupons_trainer on public.coupons(trainer_id);

-- ── TASKS (внутрішній CRM таск-менеджер тренера) ─────────────────────────────
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  trainer_id    uuid not null references public.trainers(id) on delete cascade,
  client_id     uuid references public.clients(id) on delete cascade,
  title         text not null,
  note          text,
  due_date      date, due_time text,
  duration_min  int default 30,           -- скільки триває (календар: тягнеш за нижній край)
  priority      text default 'normal',    -- low | normal | high
  done          boolean not null default false,
  remind_offset text default 'none',      -- none|at|15|30|60|custom
  remind_at     text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_tasks_trainer on public.tasks(trainer_id);

-- ── INVITES (привʼязка клієнта до тренера) ───────────────────────────────────
create table if not exists public.invites (
  token              uuid primary key default gen_random_uuid(),
  trainer_id         uuid not null references public.trainers(id) on delete cascade,
  client_id          uuid references public.clients(id) on delete cascade,  -- інвайт на конкретного клієнта (телеграм прив'яже tg до нього)
  used_by_client_id  uuid references public.clients(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists idx_invites_trainer on public.invites(trainer_id);

-- ── CUSTOM_EXERCISES (завантажені тренером) ──────────────────────────────────
create table if not exists public.custom_exercises (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  name        text not null,
  mg          text, mg_label text, type text,
  embed_url   text, bunny_id text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_customex_trainer on public.custom_exercises(trainer_id);

-- ── EX_OVERRIDES (персональні правки БАЗОВИХ 240 вправ) ──────────────────────
create table if not exists public.ex_overrides (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  exercise_id text not null,        -- id базової вправи (exercises.json)
  name text, mg text, mg_label text, type text, embed_url text, bunny_id text,
  created_at  timestamptz not null default now(),
  unique (trainer_id, exercise_id)
);

-- ── MESSAGES (чат тренер↔клієнт; поки резерв) ────────────────────────────────
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  client_id   uuid references public.clients(id) on delete cascade,
  sender      text,               -- 'trainer' | 'client'  (у mock: from)
  body        text,
  exercise_id text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_messages_client on public.messages(client_id);

-- ── updated_at триггери (лише де є колонка updated_at) ───────────────────────
do $$
declare t text;
begin
  foreach t in array array['trainers','clients','programs'] loop
    execute format(
      'drop trigger if exists trg_touch_%1$s on public.%1$s;
       create trigger trg_touch_%1$s before update on public.%1$s
       for each row execute function public.touch_updated_at();', t);
  end loop;
end $$;

-- БАЗОВІ 240 вправ (exercises.json) — довідкові, спільні для всіх тренерів.
-- Тримаємо як статичний ассет фронта (backend/exercises.json) АБО seed-имо у
-- окрему read-only таблицю exercises_base. За замовч. лишаємо як ассет — це
-- незмінні дані; custom_exercises + ex_overrides шарують поверх них у data-store.
