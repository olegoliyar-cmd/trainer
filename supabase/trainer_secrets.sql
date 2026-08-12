-- ============================================================================
-- TRAINER SaaS — trainer_secrets (мульти-бот)
-- Кожен тренер реєструє СВОЇ Telegram-боти в BotFather під власним акаунтом і
-- передає нам ТОКЕН клієнтського бота. Токен — секрет: ним telegram-auth
-- валідує initData клієнтів саме цього тренера. Тому:
--   • токен живе в окремій таблиці trainer_secrets, закритій RLS так, що його
--     читає ЛИШЕ service_role (Edge Function). Anon/authenticated — нічого.
--   • @usernames ботів (НЕ секрет) — у trainers, доступні тренеру через звичайну RLS.
--   • тренер задає свій токен через SECURITY DEFINER RPC set_trainer_bot_token()
--     (пише лише у СВІЙ рядок; функції ЧИТАННЯ токена немає — не леакаємо).
-- Запускати ПІСЛЯ schema.sql + policies.sql. Ідемпотентно.
-- ============================================================================

-- ── @usernames ботів (публічні, не секрет) → у trainers ──────────────────────
alter table public.trainers add column if not exists client_bot_username  text;
alter table public.trainers add column if not exists trainer_bot_username  text;

-- ── trainer_secrets: ТОКЕН клієнтського бота (секрет, service_role only) ──────
create table if not exists public.trainer_secrets (
  trainer_id        uuid primary key references public.trainers(id) on delete cascade,
  client_bot_token  text,               -- токен клієнтського бота тренера (BotFather)
  updated_at        timestamptz not null default now()
);

-- RLS увімкнено, ЖОДНОЇ політики для anon/authenticated → доступ лише service_role
-- (service_role обходить RLS). Так токен недосяжний ні клієнтам, ні тренерам.
alter table public.trainer_secrets enable row level security;
revoke all on public.trainer_secrets from anon, authenticated;

-- ── RPC: тренер задає/оновлює СВІЙ токен (не бачачи чужих і не читаючи назад) ─
-- security definer → виконується від власника (postgres, обходить RLS), але
-- пише СТРОГО у рядок current_trainer_id() → тренер не може чіпати чужий токен.
create or replace function public.set_trainer_bot_token(p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  tid := public.current_trainer_id();
  if tid is null then raise exception 'no trainer for current user'; end if;
  insert into public.trainer_secrets(trainer_id, client_bot_token, updated_at)
  values (tid, nullif(p_token, ''), now())
  on conflict (trainer_id) do update
    set client_bot_token = nullif(p_token, ''), updated_at = now();
end $$;
revoke all on function public.set_trainer_bot_token(text) from public;
grant execute on function public.set_trainer_bot_token(text) to authenticated;

-- Чи підключено бота (лише булеве «є токен», без самого токена) — для UI-статусу.
create or replace function public.has_trainer_bot_token()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select client_bot_token is not null and client_bot_token <> ''
    from public.trainer_secrets where trainer_id = public.current_trainer_id()
  ), false)
$$;
revoke all on function public.has_trainer_bot_token() from public;
grant execute on function public.has_trainer_bot_token() to authenticated;
