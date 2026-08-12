# TRAINER — SaaS-платформа для персональних тренерів

B2B-платформа: у тренера — адмінка (CRM, клієнти, програми, календар), у його клієнтів — Telegram Mini App (тренування, харчування, звіти, прогрес). Мультитенантність: кожен тренер = свій бот + свої клієнти. Виросло з клубного застосунку GrekFit (архів — в `archive/`).

## Структура

```
TRAINER/
├── dev-server.mjs        ← вхідна точка розробки: node dev-server.mjs (порт 3210)
│                            /            → прев'ю-перемикач (клієнт·тел / тренер·тел / тренер·веб)
│                            /trainer/    → адмінка
│                            /api/*       → mock-бекенд (backend/api.mjs)
├── data-store.js         ← mock DataStore (localStorage + /api). У проді підміняється
│                            на supabase/data-store.supabase.js (адмінка) чи .client.js (клієнт)
│
├── trainer-admin/        ← АДМІНКА ТРЕНЕРА (один файл!)
│   ├── index.html        ← весь застосунок: HTML+CSS+JS інлайн (~580 КБ)
│   ├── super.html        ← супер-адмінка (онбординг тренерів, контроль-база)
│   └── preview.html      ← дев-шелл: Веб / Мобайл / Обидва (клавіші W/M/B)
│
├── trainer-app/          ← КЛІЄНТСЬКИЙ APP (Telegram Mini App, теж один файл)
│   ├── index.html        ← весь застосунок
│   ├── preview.html      ← прев'ю-перемикач (сервиться на / дев-сервера)
│   ├── assets/           ← картинки, gf-sync.js (TrainerSync міст)
│   ├── docs/             ← публічні сторінки: privacy / terms / medical / refund
│   ├── dev/              ← дев-шели iPhone-рамок і мокапи (НЕ деплояться)
│   └── _headers          ← заголовки Cloudflare Pages
│
├── backend/              ← MOCK-БЕКЕНД для локальної розробки
│   ├── api.mjs           ← роути /api/*
│   ├── store.mjs         ← логіка + сід демо-даних
│   ├── data.json         ← локальна "база" (Вася/Оксана/…)
│   └── exercises.json    ← база вправ (сервиться і в прод-бандл адмінки)
│
├── supabase/             ← ПРОД-БЕКЕНД (Supabase)
│   ├── schema.sql + *.sql← схема й міграції (meetings, daily_reports, chat…)
│   ├── data-store.supabase.js ← DataStore адмінки (той самий інтерфейс, що mock)
│   ├── data-store.client.js   ← DataStore клієнтського апу
│   └── functions/        ← Edge Functions: telegram-webhook, admin-api, client-api,
│                            meeting-create, formcheck-review, bunny-upload, крони…
│
├── docs/                 ← документація і плани
│   ├── HANDOFF-TRAINER-SAAS.md  ← ⭐ передача між сесіями (читати першим)
│   ├── DESIGN.md                ← дизайн-система (Linear): поверхні, радіуси, відступи
│   └── PLAN-*.md/html           ← плани: MVP-борд, go-live, рев'ю
│
├── archive/              ← старий проєкт GrekFit (снапшот) + legacy-скрипти
└── .dev-secrets.env      ← токени CF/Supabase/Bunny/боти (gitignored, НЕ комітити)
```

## Запуск локально

```bash
node dev-server.mjs
# → http://localhost:3210/          прев'ю обох апів
# → http://localhost:3210/trainer/  адмінка напряму
```

Порт може бути зайнятий (autoPort) — дивись реальний порт у виводі.

## Деплой (Cloudflare Pages, секрети з .dev-secrets.env)

- **Адмінка** `traineros-admin`: бандл = `trainer-admin/index.html` + `trainer-admin/super.html` + `supabase/data-store.supabase.js` + `backend/exercises.json`
- **Клієнт** `traineros-app`: бандл = `trainer-app/*` (без `dev/`) + `supabase/data-store.client.js` + `data-store.js`; кеш-бастер `?b=mtbNN`
- Команда: `npx wrangler@3 pages deploy <dir> --project-name=<proj> --branch=main --commit-dirty=true`
- Перед деплоєм: витягти інлайн-скрипти → `node --check`
- DDL у прод: Supabase Management API `POST /v1/projects/{ref}/database/query` (+браузерний User-Agent)

## Ключове

- Обидва апи — **однофайлові** (index.html з інлайн CSS/JS, без білдера і залежностей).
- Режим визначається в рантаймі: localhost → mock `data-store.js`, прод → Supabase-стори (однаковий інтерфейс `DataStore.*`).
- Прод-тенант: тренер Роман (GREKFIT), `879190a8-3b72-4b01-98cc-10b92b68058b`. У проді є демо-клієнти — прибрати перед запуском.
- Час зустрічей у UI — завжди локальний (`mtLocalHHMM`); все, що липне до верху в TG — `--tg-safe-top`, не `env(safe-area-inset-top)`.
