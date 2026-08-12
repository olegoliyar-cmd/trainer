# Supabase — перехід із mock-бекенду

Головна ідея (HANDOFF §5): усе об'єднують **ДАНІ**, не інфраструктура. Один Supabase, `trainer_id` на кожному рядку, ізоляція = **RLS**. Модель `backend/store.mjs` лягає в схему майже 1-в-1.

## Що змінюється / що НІ

| Файл | Змінюється? |
|---|---|
| `data-store.js` (спільний шар) | ✅ **ЛИШЕ цей файл** переписуємо на supabase-js (див. `data-store.supabase.js`) |
| `trainer-admin/index.html` | ❌ ні (ті самі `DataStore.*` методи) |
| `trainer-app/index.html` | ❌ ні (ті самі методи + `TrainerSync`) |
| `backend/*.mjs`, `dev-server.mjs` | ❌ лишаються як **локальний mock для розробки** (можна ганяти офлайн) |

Фронти вже викликають лише `DataStore.*` — тому свап шару даних їх не чіпає.

## Кроки

1. **Створити проєкт** на supabase.com → узяти `Project URL` і `anon public` ключ (Settings → API). `service_role` ключ — тільки для Edge Functions, НІКОЛИ у фронт.
2. **Схема**: SQL Editor → виконати `schema.sql`.
3. **RLS**: виконати `policies.sql`.
4. **Тренер + Auth**:
   - Auth → Users → створити акаунт тренера (email/пароль або magic link).
   - Вставити рядок у `trainers`, прив'язавши `owner` до `auth.users.id` цього акаунта, і задати `slug` (напр. `grekfit`), `brand_name`, `accent`, `pipeline`, `exercise_groups`. Приклад — `seed.sql` (за бажанням).
5. **Storage** (фото/відео): бакет `progress` (private). Доступ — через Edge Function / signed URLs. Поки фронт шле `thumb` як dataURL — працює без Storage; переведення на Storage — окремий крок.
6. **Свап data-store.js**: скопіювати `supabase/data-store.supabase.js` → `data-store.js` (або підмінити `<script src>`), і задати конфіг (див. нижче). Перевірити обидва фронти локально проти реального Supabase.
7. **Тенант-роутинг**: клієнтський апп читає `?trainer=<slug>` → `trainer_public` вью (публічний select для anon). Адмінка визначає тренера з JWT (`current_trainer_id()`), НЕ з URL.
8. **Edge Function `client-api`** (service_role): усі мутації клієнта (логи/харчування/виміри/фото) йдуть сюди з підписаним токеном клієнта (виданим при `bindInvite`). Anon напряму в тенантні таблиці не пише.
9. **Хостинг**: Cloudflare Pages → `admin.домен` (адмінка) + `app.домен` (клієнт). Той самий код, тенант через slug/JWT.
10. **Пуші/нагадування**: Edge Functions по крону → Telegram (бот тренера для клієнтів). Значення нагадувань у `tasks.remind_*` уже зберігаються.

## Конфіг для data-store.supabase.js

У `<head>` кожного фронта (або в окремому `config.js`) до підключення data-store:

```html
<script>
  window.SUPABASE_URL = 'https://<project>.supabase.co';
  window.SUPABASE_ANON_KEY = '<anon-public-key>';
</script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script src="/data-store.js"></script>
```

## Мапінг методів DataStore → таблиці

- `trainerBundle(id)` → `trainers` + агрегати (`clients`+assigned program, `programs`, `payments`, `coupons`, `tasks`).
- `clientBundle(id)` → `clients` + assigned `programs` (через `assignments`) + `trainer`.
- `createClient/updateClient/deleteClient` → `clients` (delete = FK `on delete cascade` прибирає дітей).
- `addClientPhoto/deleteClientPhoto` → `client_photos`; `addClientMeasurement/deleteClientMeasurement` → `client_measurements`.
- `listLogs/createLog/deleteLog` → `workout_logs`.
- `listNutrition/addNutrition/reviewNutrition/deleteNutrition` → `nutrition_logs`.
- `listExercises` → `exercises.json` (база) ⊕ `custom_exercises` ⊕ `ex_overrides`; `createExercise`→`custom_exercises`; `updateExercise` базової→`ex_overrides`.
- `assignProgram/createClientProgram` → `programs` + `assignments`.
- payments/coupons/tasks/invites → однойменні таблиці.

## Важливо

- **RLS перевіряй на реальних даних**: 2 тренери не мають бачити рядки одне одного. Тест: залогінься кожним, `select * from clients` — має вертати лише свої.
- **service_role ключ** — тільки в Edge Functions (серверне середовище), ніколи в браузер.
- Базові 240 вправ лишаються статичним ассетом (`backend/exercises.json`); custom + overrides шарують поверх у data-store.
