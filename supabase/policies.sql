-- ============================================================================
-- TRAINER SaaS — Row Level Security (RLS)
-- Запускати ДРУГИМ (після schema.sql).
--
-- Модель доступу (з HANDOFF §5):
--   • ТРЕНЕР → Supabase Auth. Бачить/пише ЛИШЕ рядки свого trainer_id.
--   • КЛІЄНТ → анонімний (Telegram). Прямого доступу через anon-ключ НЕ дає:
--       – читання брендингу тренера: публічний VIEW trainer_public (лише бренд-поля);
--       – усі мутації клієнта (логи/харчування/виміри/фото) — ЧЕРЕЗ Edge Function
--         `client-api` із service_role, що валідує підписаний токен клієнта
--         (виданий при bindInvite). Так anon-ключ ніколи не пише напряму.
-- ============================================================================

-- Хелпер: trainer_id поточного авторизованого тренера (owner = auth.uid()).
create or replace function public.current_trainer_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.trainers where owner = auth.uid() limit 1
$$;

-- Увімкнути RLS на всіх таблицях ------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'trainers','clients','programs','assignments','workout_logs','nutrition_logs',
    'client_measurements','client_photos','payments','coupons','tasks','invites',
    'custom_exercises','ex_overrides','messages'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- ── TRAINERS: тренер бачить/редагує лише свій рядок ──────────────────────────
drop policy if exists trainers_self on public.trainers;
create policy trainers_self on public.trainers
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- ── ТЕНАНТНІ ТАБЛИЦІ: trainer_id = current_trainer_id() ──────────────────────
-- Один шаблон для всіх таблиць із колонкою trainer_id.
do $$
declare t text;
begin
  foreach t in array array[
    'clients','programs','assignments','workout_logs','nutrition_logs',
    'client_measurements','client_photos','payments','coupons','tasks','invites',
    'custom_exercises','ex_overrides','messages'
  ] loop
    execute format('drop policy if exists %1$s_tenant on public.%1$s;', t);
    execute format($f$
      create policy %1$s_tenant on public.%1$s
        for all to authenticated
        using (trainer_id = public.current_trainer_id())
        with check (trainer_id = public.current_trainer_id());
    $f$, t);
  end loop;
end $$;

-- ── Публічне читання брендингу тренера для клієнтського апу (anon) ────────────
-- Лише безпечні бренд-поля. Клієнт відкриває апп за ?trainer=slug.
-- ВАЖЛИВО: security_invoker=FALSE (security-definer вью, власник=postgres) — щоб
-- anon читав бренд ЧЕРЕЗ вью, не маючи прямого доступу до таблиці trainers.
drop view if exists public.trainer_public;
create view public.trainer_public
  with (security_invoker = false) as
  select id, slug, brand_name, trainer_name, photo_url, telegram_chat_url, accent
  from public.trainers;

-- Пряма таблиця trainers лишається закритою для anon; бренд — лише через вью.
revoke all on public.trainers from anon;
grant select on public.trainer_public to anon, authenticated;

-- ── КЛІЄНТСЬКІ МУТАЦІЇ — через service_role (Edge Function), RLS їх омине ─────
-- service_role обходить RLS. Edge Function `client-api` перевіряє підписаний
-- токен клієнта (client_id + trainer_id + tg_user_id), і від його імені робить
-- insert/select у clients/workout_logs/nutrition_logs/client_measurements/
-- client_photos/assignments. Жодних прямих anon-write політик не додаємо.

-- ── Storage (фото прогресу/харчування, відео) — приклад політики бакета ──────
-- Створи бакет `progress` (private). Доступ — теж через Edge Function/signed URLs.
-- (Приклад політики лишаємо в README, бо залежить від назв бакетів.)
