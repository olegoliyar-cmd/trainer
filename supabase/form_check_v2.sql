-- ============================================================================
-- Розбори 2.0 — багата відповідь тренера + збереження відео для повтору.
--   • відповідь = текст + розмічений скрін (image) + голосове (voice)
--   • відео клієнта БІЛЬШЕ НЕ видаляється на review (клієнт передивляється)
--   • client_seen — для бейджа «новий розбір» у клієнта
-- Запускати через Management API (як інші DDL).
-- ============================================================================

alter table public.form_check_requests
  add column if not exists response_text        text,
  add column if not exists response_image_path  text,   -- розмічений скрін у бакеті form-checks
  add column if not exists response_voice_path  text,   -- голосове тренера у бакеті form-checks
  add column if not exists client_seen          boolean not null default true;
--        ↑ свіже відео клієнта = seen (нема чого дивитись); на review ставимо false.

-- Тренер вантажить розмічений скрін / голосове у СВІЙ префікс (як read/delete).
drop policy if exists formcheck_insert_own on storage.objects;
create policy formcheck_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'form-checks'
    and (storage.foldername(name))[1] = public.current_trainer_id()::text
  );
