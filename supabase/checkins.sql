-- ============================================================================
-- ГОЛОСОВІ ЧЕК-ІНИ: клієнт відповідає голосовим боту → тренер бачить в адмінці.
-- kind: daily (вечірній стан) | postworkout (після тренування)
-- status: new (тренер ще не бачив) | seen
-- transcript/summary заповнюються, коли є AI-ключі (OPENAI/ANTHROPIC) — інакше null.
-- ============================================================================
create table if not exists public.checkins (
  id          uuid primary key default gen_random_uuid(),
  trainer_id  uuid not null references public.trainers(id) on delete cascade,
  client_id   uuid not null references public.clients(id)  on delete cascade,
  kind        text not null default 'daily',
  audio_path  text,
  transcript  text,
  summary     text,
  status      text not null default 'new',
  created_at  timestamptz not null default now()
);
create index if not exists idx_checkins_trainer on public.checkins(trainer_id, status, created_at desc);
create index if not exists idx_checkins_client on public.checkins(client_id, created_at desc);
alter table public.checkins enable row level security;
drop policy if exists checkins_tenant on public.checkins;
create policy checkins_tenant on public.checkins
  for all to authenticated
  using (trainer_id = public.current_trainer_id())
  with check (trainer_id = public.current_trainer_id());

-- Приватний бакет аудіо; тренер читає свій префікс (service_role пише з webhook)
insert into storage.buckets (id,name,public) values ('checkins','checkins',false) on conflict (id) do nothing;
drop policy if exists checkins_read_own on storage.objects;
create policy checkins_read_own on storage.objects
  for select to authenticated
  using (bucket_id='checkins' and (storage.foldername(name))[1] = public.current_trainer_id()::text);

-- Тогл щоденного чек-іну + анти-спам маркери
alter table public.clients add column if not exists checkin_daily boolean not null default false;
alter table public.clients add column if not exists checkin_asked_at date;
alter table public.clients add column if not exists pw_asked_at date;
