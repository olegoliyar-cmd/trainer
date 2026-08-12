-- ============================================================================
-- Фіча «Відео тренеру» (form-check / розбір техніки)
-- Клієнт на екрані вправи знімає коротке відео → тренер бачить розділ «Розбори»
-- з лічильником → відповідає текстом (через trainer-feedback, context=formcheck).
--
-- Сховище відео: приватний Storage-бакет `form-checks`, path = tid/cid/uuid.mp4.
--   • Клієнт вантажить по signed upload URL (client-api → createSignedUploadUrl).
--   • Тренер читає по signed URL (RLS: свій префікс trainer_id) і видаляє на review.
--
-- Запускати через Management API SQL (як інші DDL цього проєкту).
-- ============================================================================

-- ── Таблиця запитів на розбір ────────────────────────────────────────────────
create table if not exists public.form_check_requests (
  id            uuid primary key default gen_random_uuid(),
  trainer_id    uuid not null references public.trainers(id) on delete cascade,
  client_id     uuid not null references public.clients(id)  on delete cascade,
  exercise_name text,
  video_path    text,                       -- шлях у бакеті form-checks (nullиться після review)
  note          text,                       -- опційна нотатка клієнта
  status        text not null default 'new',-- new | reviewed
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz
);
create index if not exists idx_formcheck_trainer_status
  on public.form_check_requests(trainer_id, status, created_at desc);
create index if not exists idx_formcheck_client
  on public.form_check_requests(client_id);

-- RLS: тенантна політика (тренер full-access лише свої рядки; клієнт пише через client-api/service_role)
alter table public.form_check_requests enable row level security;
drop policy if exists form_check_requests_tenant on public.form_check_requests;
create policy form_check_requests_tenant on public.form_check_requests
  for all to authenticated
  using (trainer_id = public.current_trainer_id())
  with check (trainer_id = public.current_trainer_id());

-- ── Storage-бакет (приватний) ────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
  values ('form-checks', 'form-checks', false)
  on conflict (id) do nothing;

-- Тренер читає/видаляє лише обʼєкти у своєму префіксі: <trainer_id>/...
-- (клієнтський аплоуд іде через service_role у client-api, RLS його оминає)
drop policy if exists formcheck_read_own on storage.objects;
create policy formcheck_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'form-checks'
    and (storage.foldername(name))[1] = public.current_trainer_id()::text
  );

drop policy if exists formcheck_delete_own on storage.objects;
create policy formcheck_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'form-checks'
    and (storage.foldername(name))[1] = public.current_trainer_id()::text
  );
