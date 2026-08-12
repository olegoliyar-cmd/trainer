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
