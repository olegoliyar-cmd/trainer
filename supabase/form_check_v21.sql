-- ============================================================================
-- Розбори 2.1 — КІЛЬКА розмічених скрінів на один розбір + доповнення розбору.
--   • response_images jsonb  — масив шляхів ["tid/cid/a.jpg", ...] (нижня точка,
--     верхня точка присіду тощо; кожен зі своєю розміткою)
--   • response_voices jsonb  — масив голосових (доповнення не має затирати старе)
--   • легасі response_image_path / response_voice_path НЕ дропаємо: старі рядки
--     читаються як [path], якщо масив порожній.
-- Запускати через Management API (як інші DDL).
-- ============================================================================

alter table public.form_check_requests
  add column if not exists response_images jsonb not null default '[]'::jsonb,
  add column if not exists response_voices jsonb not null default '[]'::jsonb;

-- Бекфіл: наявні одиночні шляхи → масиви (щоб уся логіка читала лише масиви).
update public.form_check_requests
   set response_images = jsonb_build_array(response_image_path)
 where response_image_path is not null
   and (response_images is null or jsonb_array_length(response_images) = 0);

update public.form_check_requests
   set response_voices = jsonb_build_array(response_voice_path)
 where response_voice_path is not null
   and (response_voices is null or jsonb_array_length(response_voices) = 0);
