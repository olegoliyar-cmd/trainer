-- ============================================================================
-- ФОТО ПРОГРЕСУ У ПОВНІЙ ЯКОСТІ (кейси «було → стало»).
-- Раніше фото жило лише як стиснутий data-URL thumb у БД — для кейсів не годиться.
-- Тепер: оригінал (до ~1600px) у приватному бакеті progress-photos,
--        thumb лишається в рядку (швидка сітка без мережі).
--   path: tid/cid/uuid.jpg
-- ============================================================================
alter table public.client_photos
  add column if not exists path text;

insert into storage.buckets (id, name, public)
values ('progress-photos','progress-photos', false)
on conflict (id) do nothing;

-- Тренер читає/видаляє лише свій префікс (trainer_id). Клієнт вантажить через
-- signed upload URL з client-api (service_role), тому окрема insert-політика не потрібна.
drop policy if exists progress_photos_read_own on storage.objects;
create policy progress_photos_read_own on storage.objects
  for select to authenticated
  using (bucket_id='progress-photos' and (storage.foldername(name))[1] = public.current_trainer_id()::text);

drop policy if exists progress_photos_del_own on storage.objects;
create policy progress_photos_del_own on storage.objects
  for delete to authenticated
  using (bucket_id='progress-photos' and (storage.foldername(name))[1] = public.current_trainer_id()::text);
