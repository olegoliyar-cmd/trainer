-- ============================================================================
-- БЛОК 3: КАЛЕНДАР / ЗУСТРІЧІ (дзвінки тренер ↔ клієнт)
--   kind:   online (Jitsi-лінк генерується автоматично) | gym (очна)
--   status: planned → confirmed | declined (кнопки в Telegram) → done | cancelled
--   rem24/rem1 — маркери надісланих нагадувань (крон, щогодини)
-- ============================================================================
create table if not exists public.meetings (
  id           uuid primary key default gen_random_uuid(),
  trainer_id   uuid not null references public.trainers(id) on delete cascade,
  client_id    uuid not null references public.clients(id)  on delete cascade,
  starts_at    timestamptz not null,
  duration_min int  not null default 30,
  kind         text not null default 'online',
  link         text,
  note         text,
  status       text not null default 'planned',
  rem24_sent   boolean not null default false,
  rem1_sent    boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists idx_meetings_trainer on public.meetings(trainer_id, starts_at);
create index if not exists idx_meetings_client  on public.meetings(client_id, starts_at);

alter table public.meetings enable row level security;
drop policy if exists meetings_tenant on public.meetings;
create policy meetings_tenant on public.meetings
  for all to authenticated
  using (trainer_id = public.current_trainer_id())
  with check (trainer_id = public.current_trainer_id());
