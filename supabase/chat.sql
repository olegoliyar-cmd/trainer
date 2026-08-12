-- ============================================================================
-- ВНУТРІШНІЙ ЧАТ тренер ↔ клієнт (замість деплінка в Telegram + окремого «фідбеку»).
-- Одна стрічка: текст + голосові. Коментарі тренера по тренуванню/харчуванню —
-- це ті самі повідомлення, лише з міткою контексту (context/ref_date).
-- Розбори техніки лишаються ОКРЕМОЮ сутністю (відео+розмітка), не чатом.
-- Будуємо на зарезервованій таблиці public.messages.
-- ============================================================================
alter table public.messages
  add column if not exists voice_path     text,
  add column if not exists context        text,          -- null | 'workout' | 'nutrition'
  add column if not exists ref_date       date,
  add column if not exists seen_by_client boolean not null default false,
  add column if not exists seen_by_trainer boolean not null default false;

create index if not exists idx_messages_thread on public.messages(client_id, created_at);

alter table public.messages enable row level security;
drop policy if exists messages_tenant on public.messages;
create policy messages_tenant on public.messages
  for all to authenticated
  using (trainer_id = public.current_trainer_id())
  with check (trainer_id = public.current_trainer_id());

-- Приватний бакет голосових чату (шлях: tid/cid/uuid.webm)
insert into storage.buckets (id,name,public) values ('chat','chat',false) on conflict (id) do nothing;
drop policy if exists chat_read_own on storage.objects;
create policy chat_read_own on storage.objects
  for select to authenticated
  using (bucket_id='chat' and (storage.foldername(name))[1] = public.current_trainer_id()::text);
drop policy if exists chat_insert_own on storage.objects;
create policy chat_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id='chat' and (storage.foldername(name))[1] = public.current_trainer_id()::text);

-- ── Одноразова міграція: старий client_feedback → повідомлення тренера в чаті ──
insert into public.messages (trainer_id, client_id, sender, body, context, ref_date, seen_by_client, seen_by_trainer, created_at)
select f.trainer_id, f.client_id, 'trainer', f.text,
       nullif(f.context,'formcheck'),          -- відповіді на розбори лишаються в Розборах
       f.ref_date, coalesce(f.seen,false), true, f.created_at
from public.client_feedback f
where f.context is distinct from 'formcheck'
  and not exists (
    select 1 from public.messages m
    where m.client_id = f.client_id and m.sender='trainer'
      and m.body = f.text and m.created_at = f.created_at
  );
