# PLAN — Go-live повного мультитенанту

**Дедлайн: 2026-07-11 (післязавтра), кінець дня.** Створено 2026-07-09.
Читати разом із `HANDOFF-TRAINER-SAAS.md` (детальний стан) та авто-памʼяттю.

## Мета
Довести екосистему до **реального робочого стану на одному справжньому тренері**: реальні боти, реальний Bunny Stream, єдина «база контролю» всіх тренерів (супер-адмін) та єдине надійне сховище всіх паролів/токенів.

---

## Зафіксовані рішення (НЕ переобговорювати)
- **2 боти на тренера** (тренерський → адмінка fullscreen; клієнтський → клієнти). Тренер реєструє їх **сам** у BotFather під своїм акаунтом і віддає нам токен клієнтського бота (обходить ліміт ~20/акаунт; справжній white-label). Пам'ять: `decision-two-bots-per-trainer`, `decision-trainer-owns-bots`.
- **Мульти-бот `telegram-auth` + `trainer_secrets`** — ✅ ГОТОВО+ЖИВЕ (2026-07-09). Токен клієнтського бота секретний (service_role only), валідація initData токеном потрібного тренера, env-fallback для сумісності.
- **Bunny Stream** (2026-07-09, рішення): спільна платформна бібліотека **за замовчуванням**, але код **per-trainer-ready** — `trainer_secrets.bunny_library_id`+`bunny_key` як fallback (той самий патерн, що бот-токен): є свої → у свою бібліотеку, нема → у спільну. **Collection на кожного тренера** всередині спільної (візуальне+логічне розділення, страх злиття закрито). **Підписаний embed** (Token Authentication). Ключ Bunny — ЛИШЕ на сервері (Edge Function); у нашій базі — **лише посилання** (bunny_id + embed-URL), не саме відео. Аплоуд — **direct TUS** (браузер вантажить байти напряму в Bunny по presigned-підпису, великий файл не йде через наш сервер). Вартість шаред vs окремі — майже однакова (Bunny рахує за ГБ збереження+трафік, не за кількість бібліотек); різниця лише в складності керування.
- Приватність відео: **підписаний embed** (обрано користувачем).

---

## Фази до дедлайну

### Фаза A — Реальний тренер + реальні боти
- [ ] Створити **реального** тренера (не demo): Supabase Auth-акаунт + рядок `trainers` (slug, brand_name, trainer_name, accent, pipeline, exercise_groups). Зафіксувати логін/пароль у сховищі.
- [ ] Тренер створює **2 реальні боти** в BotFather (за гайдом «Мій бот»). Для першого — можемо зробити разом.
- [ ] Токен клієнтського бота → `trainer_secrets` (через UI «Мій бот» або напряму RPC).
- [ ] Виставити Main Mini App URL: клієнтський бот → `app.<домен>/?trainer=<slug>`; тренерський бот → `admin.<домен>`. Menu button через Bot API.
- [ ] **Перенести токен Романа/GREKFIT** у `trainer_secrets` (прибрати опору на env-fallback).

### Фаза B — Bunny Stream (відео-шар) — ✅ ГОТОВО+ЖИВЕ 2026-07-09
- [x] Креди Bunny: Library ID `700844`, API key, CDN `vz-cbd6244f-b08.b-cdn.net`, Token Auth key — у `.dev-secrets.env` + секрети Edge Function (`BUNNY_LIBRARY_ID/API_KEY/CDN_HOST/TOKEN_AUTH_KEY`).
- [x] Edge Function `bunny-upload` задеплоєно: auth тренера (Supabase JWT) → `create` (POST /library/{id}/videos → guid) + presigned TUS-підпис (`sha256(lib+key+expire+guid)`); per-trainer fallback (`trainer_secrets.bunny_library_id/bunny_api_key`); авто-Collection тренера (`trainers.bunny_collection_id`); підписаний embed (`sha256(token_auth_key+guid+expires)`).
- [x] Адмінка «Додати вправу»: реальний **direct TUS** аплоуд (tus-js-client, браузер→Bunny по підпису) → `createExercise`(bunny_id, embed_url). Mock прибрано. Задеплоєно на traineros-admin.
- [x] E2E перевірено: create 200, TUS POST 201/PATCH 204 (файл залився), браузерний invoke ok (фікс CORS: +apikey/x-client-info), embed 200.
- [ ] Клієнтський апп: відтворення embed вправ (успадкує embed_url з програми — перевірити при призначенні).
- [ ] `ex_overrides` для базових 240 — той самий шлях (за потреби).
- ⚠️ Строге embed-token enforcement на бібліотеці зараз НЕ увімкнено (embed 200 і без токена) — підписаний URL уже готовий, якщо вмикатимемо. Реальна перевірка «грає» — залити справжнє відео в адмінці.

### Фаза C — База контролю (СУПЕР-АДМІН) — ✅ ГОТОВО+ЖИВЕ 2026-07-09
- [x] `platform_admins(user_id)` (service_role only) + поля `trainers.platform_status/platform_plan/onboarded_at`.
- [x] Edge Function `admin-api` (gate: user_id ∈ platform_admins): `trainers.list` (усі тренери + бот✓/клієнти/статус), `trainer.create` (auth user + trainers row з дефолтами GREKFIT: 6 стадій воронки, 9 груп, accent із кольору; відкат user при помилці).
- [x] Сторінка **`https://traineros-admin.pages.dev/super`** (файл `trainer-admin/super.html`, фіолетовий «платформний» бренд): логін → реєстр тренерів (картки: бренд, slug, @бот, бот✓, клієнтів, статус) + «Додати тренера» (email/пароль/slug/бренд/колір) → показ креденшелів для передачі тренеру.
- [x] Супер-адмін акаунт: **super@traineros.app / [REDACTED-2026-08-15 — див. SECRETS-LOCAL.md] (у `platform_admins`; змінити пароль). E2E: список 200, гейт Романа 403, створення тренера з дефолтами + відкат — усе ок.
- ⚠️ Cloudflare Pages прибирає `.html` → URL = `/super` (не `/super.html`, той 308-редіректить).
- [ ] Далі (за потреби): дії в реєстрі (пауза/оплата/видалення тренера), автосідинг програм при створенні, довідник bunny library/collection.

### Фаза D — Єдине сховище секретів (усе в одному місці)
- [ ] Per-trainer секрети (бот-токен, bunny key) → **`trainer_secrets`** (service_role only) — вже є для бота, додати bunny.
- [ ] Інфра-токени (Cloudflare, Supabase sbp, Bunny платформний) → **`.dev-secrets.env`** (локально, 600, gitignored) + **резервна копія в менеджері паролів користувача**. Пам'ять: `reference-dev-secrets-file`.
- [ ] Паролі логінів тренерів → фіксувати при створенні (для передачі тренеру), зберігати в тому ж надійному місці.
- [ ] Таблиця «що де лежить» — тримати в цьому плані (нижче).

### Фаза E — Онбординг-флоу «Додати тренера» (автоматизація чек-листа)
- [ ] Кнопка в супер-адмін: створює auth + `trainers` + сідить програми/групи + Bunny Collection автоматично. Ручним лишається лише створення ботів тренером (за гайдом) + вставка токена.

### Фаза F — Домени (бажано до дедлайну, не блокер)
- [ ] Кастомний домен замість `*.pages.dev`: `admin.<продукт>` + `app.<продукт>` через Cloudflare. Тенант через `?trainer=slug` (старт) або піддомен (апгрейд).

---

## Потрібно від користувача (для решти)
1. ⚠️ **BotFather ручний крок** (клієнтський бот Романа): Main Mini App URL = `https://traineros-app.pages.dev/?trainer=grekfit` (без нього не працюють інвайти-`?startapp=`). @grekfit_training_bot → Bot Settings → Configure Mini App → Enable → URL.
2. Рішення по **домену** (спільний / піддомени / кастомний) — для Фази F.
3. (Опц.) Змінити пароль супер-адміна та Романа; Revoke старого sbp (новий уже в `.dev-secrets.env`).

---

## Сховище секретів — «що де лежить»
| Що | Де | Нотатка |
|---|---|---|
| Cloudflare API token + account | `.dev-secrets.env` | ✅ |
| Supabase sbp (mgmt) | `.dev-secrets.env` `SUPABASE_MGMT_TOKEN` | ✅ (робочий) |
| Supabase publishable/anon | вшито в апи | публічний, не секрет |
| Bunny (lib 700844 / api key / cdn / token-auth key) | `.dev-secrets.env` + Edge Function secrets | ✅ |
| Бот-токен клієнтського бота Романа | `trainer_secrets.client_bot_token` (service_role) | ✅ @grekfit_training_bot |
| Bunny per-trainer ключі (опц.) | `trainer_secrets.bunny_library_id/bunny_api_key` | коли підуть окремі бібліотеки |
| Супер-адмін логін | `.dev-secrets.env` `SUPERADMIN_*` | super@traineros.app |
| Логіни/паролі тренерів | показуються при створенні в /super → менеджер паролів | Роман: roman@grekfit.app / [REDACTED-2026-08-15 — див. SECRETS-LOCAL.md] |

---

## Статус на 2026-07-09 (звідки продовжувати в Варшаві)
**Платформа мультитенантна й ЖИВА.** Зроблено цієї сесії:
- ✅ **Мульти-бот ядро** (`trainer_secrets`+`telegram-auth`), адмінка «Мій бот» + гайд + Telegram fullscreen, клієнт бренд за `?trainer=slug`.
- ✅ **Фаза A — реальні боти Романа:** @grekfit_training_bot (клієнт, токен у trainer_secrets) + @grekfit_admin_bot (тренер, меню→кабінет). Інвайти на бот тренера. E2E ok.
- ✅ **Фаза B — Bunny Stream:** `bunny-upload` (create+TUS+Collection+signed embed), реальний аплоуд в адмінці. E2E ok.
- ✅ **Фаза C — база контролю:** `traineros-admin.pages.dev/super` (super@traineros.app / [REDACTED-2026-08-15 — див. SECRETS-LOCAL.md]) — реєстр тренерів + «Додати тренера».
- ✅ **Фаза D — секрети:** `.dev-secrets.env` + `trainer_secrets`.

**Живі URL:** admin `traineros-admin.pages.dev` · super `…/super` · client `traineros-app.pages.dev` · Supabase ref `owkxlpuuvmybdsfwebzo`.
**Edge Functions:** telegram-auth, client-api, bunny-upload, admin-api (усі задеплоєні).

**▶️ НАСТУПНЕ (Варшава):**
1. **Відтворення відео вправ у КЛІЄНТА** — замкнути цикл «тренер залив → клієнт бачить у призначеній програмі» (client-api вже віддає програму; перевірити, що embed_url доходить і грає в Mini App).
2. Дії в реєстрі супер-адміна (пауза/оплата/видалення тренера).
3. Автосідинг програм новому тренеру при створенні.
4. Фаза F — власний домен.
5. Дрібне: клієнтський бот Романа — Main Mini App у BotFather (див. вище); пуші/нагадування (крон).

Дедлайн повного завершення — **2026-07-11 EOD**.
