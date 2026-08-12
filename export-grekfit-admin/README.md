# Адмін-конструктор програм + завантаження відео — експорт для GrekFit

Пакет для перенесення в проєкт GrekFit-додатку: адмінка, через яку Роман
**складає програми тренувань** і **завантажує відео вправ**. Код узятий з робочої
адмінки Trainer SaaS (`reference/trainer-admin-index.html` — все в одному файлі).

**Ключова відмінність для GrekFit:** у Trainer SaaS програма складається ПІД
КЛІЄНТА і призначається йому. У GrekFit програма — **внутрішній контент додатку**:
готова програма на **6 місяців під ціль** (маса / схуднення / сила / форма...),
яку клієнт сам обирає в додатку. Що з цього випливає — в розділі «Адаптація».

---

## 1. Що всередині пакета

```
export-grekfit-admin/
├── README.md                          ← цей файл
├── reference/
│   ├── trainer-admin-index.html       ← ПОВНА адмінка (HTML+CSS+JS в одному файлі).
│   │                                     Конструктор і аплоуд — шукати за іменами функцій (нижче)
│   ├── data-store.supabase.js         ← шар даних (усі виклики до Supabase в одному місці)
│   ├── exercises.json                 ← база ~240 вправ (id, назва, група м'язів, тип, embed відео)
│   └── schema-programs.sql            ← таблиці: programs, assignments, custom_exercises, ex_overrides
└── supabase-functions/
    └── bunny-upload/index.ts          ← Edge Function: захищений посередник аплоуду в Bunny Stream
```

---

## 2. КОНСТРУКТОР ПРОГРАМ — суть і як працює

### Модель даних
Програма — один рядок таблиці `programs`, вся структура в jsonb:

```js
{
  name: "Маса · 3 місяці",
  is_template: true,            // шаблон (не прив'язаний до клієнта)
  structure: {
    weeksPerMonth: 4,           // скільки тижнів триває один "місяць" (1..8)
    months: [                   // ← масив місяців (мезоциклів)
      { name: "Місяць 1", days: [   // дні тижня всередині місяця
        { name: "День A",           // A/B/C... — тренувальний день
          exercises: [
            { id: "ex_bench",       // id з exercises.json АБО custom-вправи
              name: "Жим лежачи", mg: "chest",
              sets: 4, reps: "8-10", rest: 120,
              note: "пауза внизу 1с" }
          ] }
      ] }
    ]
  }
}
```

Тобто ієрархія: **програма → місяці → дні (A/B/C) → вправи (сети/повтори/відпочинок/нотатка)**.
Клієнтський додаток читає цю саму структуру і веде користувача по днях.

### Головні функції в `trainer-admin-index.html` (шукати за іменем)

| Функція | Що робить |
|---|---|
| `openBuilder(clientId, fromTemplate)` | Відкриває конструктор. Стан живе в глобальному об'єкті `BUILDER = {months, activeMonth, days, weeksPerMonth, ...}` |
| `renderBuilderMonths()` / `builderAddMonth()` / `builderDuplicateMonth(i)` / `builderRemoveMonth(i)` | Вкладки місяців: додати / **скопіювати місяць цілком** (основний робочий прийом: зробив Місяць 1 → копія → підняв ваги) / видалити |
| `renderBuilderDays()` | Малює дні активного місяця (День A/B/C, згортаються) |
| `builderSetWeeks(v)` | Скільки тижнів «крутиться» один місяць (1..8) |
| Пікер вправ (`pickerDay`, `ensureExLib()`) | Пошук по базі вправ із фільтром за групою м'язів; тап → вправа додається в день |
| `builderSaveAsTemplate()` | Зберігає як шаблон (`is_template:true`) — САМЕ ЦЕ потрібно GrekFit |
| `builderSaveAndAssign()` | (Trainer SaaS) зберігає + призначає клієнту — у GrekFit не потрібно |
| `programDays(p)` | Рахує к-сть днів у структурі (для списків) |

### Шар даних (`data-store.supabase.js`)
`listPrograms(trainerId)` · `createProgram(trainerId, data)` · `updateProgram(programId, patch)` ·
`assignProgram(clientId, programId)` (для GrekFit не потрібен). Все — прості виклики
`supabase.from('programs')...`; RLS ріже по `trainer_id`.

---

## 3. ЗАВАНТАЖЕННЯ ВІДЕО — суть і як працює

Тренер відкриває вправу без відео (або створює свою) → «Завантажити відео» →
файл летить у **Bunny Stream**, у БД зберігається **лише посилання** (не байти).

### Пайплайн (безпечний: API-ключ Bunny НІКОЛИ не потрапляє в браузер)

```
Браузер                        Edge Function (bunny-upload)            Bunny Stream
   │  POST {action:"create",         │                                     │
   │   title} + Bearer token   ────► │  1. створює video-об'єкт (з КЛЮЧЕМ) ─►  guid
   │                                 │  2. рахує presigned TUS-підпис      │
   │  ◄── {videoId, tusEndpoint,     │     (sha256(lib+key+expire+guid))   │
   │       signature, expire,        │                                     │
   │       embedUrl}                 │                                     │
   │  3. TUS-аплоуд БАЙТІВ напряму ──────────────────────────────────────► │
   │     (tus-js-client, ресумабл,   з прогрес-баром)                      │
   │  4. зберігає в БД лише {bunny_id, embed_url}                          │
```

### Функції в `trainer-admin-index.html`

| Функція | Що робить |
|---|---|
| `uploadVideoToBunny(file, onProgress, title)` | Весь клієнтський пайплайн: `DataStore.bunnyCreate(title)` → `new tus.Upload(file, {headers: {AuthorizationSignature, VideoId, LibraryId...}})` → `{bunnyId, embedUrl}`. Без Supabase — мок-прогрес (dev) |
| `openUpload()` / `doUpload()` | Оверлей «завантажити вправу»: назва + група м'язів + файл → створює вправу з відео |
| `attachVideo(exId)` | Доклеїти відео до ІСНУЮЧОЇ вправи (зокрема базової — через оверрайд) |
| `bunnyEmbedHtml(url)` | Обгортає embed-URL у responsive iframe (той самий, що в базових вправах) |
| `openExerciseDetail(id)` | Картка вправи: відео-плеєр + редагування назви/групи |

Потрібні на сторінці: `<script src="https://cdn.jsdelivr.net/npm/tus-js-client@4/dist/tus.min.js">`.

### Edge Function (`supabase-functions/bunny-upload/index.ts`)
- Секрети в env функції: `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_CDN_HOST`, `BUNNY_TOKEN_AUTH_KEY` (опц. — тоді embed-URL підписані).
- Мультитенантність Trainer SaaS (per-trainer колекції/ключі з `trainer_secrets`) для GrekFit **не потрібна** — один тенант, платформні env, можна викинути гілку `trainer_secrets`.
- Авторизація: `Authorization: Bearer <supabase access_token>` — функція перевіряє, що юзер існує. Для GrekFit достатньо перевірки «це адмін».

### База вправ
- `exercises.json` — ~240 базових вправ `{id, name, mg, mg_label, type, embed_url}` (частина вже з відео).
- `custom_exercises` (SQL) — власні вправи Романа з його відео.
- `ex_overrides` (SQL) — правки БАЗОВИХ вправ (перейменувати / доклеїти своє відео до вправи з базової бібліотеки), по одному рядку на вправу.

---

## 4. АДАПТАЦІЯ ПІД GREKFIT: 6-місячні програми під цілі

Що міняти (менше, ніж здається — конструктор уже вміє місяці):

1. **Прибрати клієнтську прив'язку.** Викинути `builderSaveAndAssign` /
   `assignProgram` / таблицю `assignments`. Лишається один шлях збереження —
   `builderSaveAsTemplate` (`is_template:true`). Заголовок конструктора — назва
   програми, а не ім'я клієнта.

2. **Додати поле цілі.** У таблицю `programs`:
   ```sql
   alter table programs add column goal text;          -- 'mass'|'cut'|'strength'|'shape'...
   alter table programs add column level text;         -- опц.: 'beginner'|'intermediate'|'advanced'
   alter table programs add column is_published boolean not null default false;
   ```
   В UI конструктора — селект цілі поруч із назвою. Список програм в адмінці —
   згрупувати за goal. У додатку клієнт бачить лише `is_published = true`.

3. **6 місяців = 6 вкладок місяців.** Конструктор уже підтримує довільну
   кількість місяців (`builderAddMonth`) і **копіювання місяця** — це основний
   інструмент прогресії: Місяць 1 → ⧉ Копія → підняти ваги/об'єм → Місяць 2.
   Варто лише: (а) кнопка «створити скелет на 6 місяців» (цикл із 6
   `builderAddMonth`), (б) зняти обмеження, якщо десь ліміт місяців.

4. **Прогресія тижнів усередині місяця.** Зараз `weeksPerMonth` означає «цей
   набір днів крутиться N тижнів». Для 6-місячної програми цього зазвичай
   достатньо (класика: тижні місяця однакові, прогресія між місяцями). Якщо
   треба тиждень-у-тиждень різні ваги — додати в вправу поле
   `progression: "+2.5кг/тиждень"` (текстом) або масив `weekOverrides`.

5. **Вибір програми клієнтом у додатку.** Екран «Обери ціль» → список
   опублікованих програм цієї цілі → старт = запис у профіль користувача
   `{program_id, started_at}`. Поточний день/тиждень рахується від `started_at`
   (той самий принцип, що `_pwWeekNum`/тижні місяця в Trainer SaaS).

6. **Відео-пайплайн переноситься без змін** — він не знає нічого про клієнтів.
   Розгорнути Edge Function `bunny-upload`, поставити env-секрети, підключити
   `exercises.json` + `custom_exercises` + `ex_overrides`.

## 5. Порядок перенесення (чек-ліст)

1. SQL: `schema-programs.sql` (без `assignments`) + `alter`-и з п.4.2.
2. Edge Function `bunny-upload` → deploy, env-секрети Bunny.
3. З `trainer-admin-index.html` перенести блоки (пошук за маркерами):
   - CSS/HTML конструктора: `#builder-overlay`, `.b-month-tab`, `#builder-days`
   - JS конструктора: від `async function openBuilder` до `programDays`
   - пікер вправ: `ensureExLib`, `openPicker`, `.picker-upload`
   - аплоуд: `openUpload`…`doUpload`, `uploadVideoToBunny`, `bunnyEmbedHtml`,
     `openExerciseDetail`, `attachVideo` + оверлеї `#upload-overlay`, `#exd-overlay`
   - tus: `<script ... tus-js-client@4 ...>`
4. `data-store.supabase.js` — взяти методи `listPrograms/createProgram/updateProgram`,
   `bunnyCreate`, `createExercise/updateExercise`, викинути клієнтські.
5. Прибрати «Зберегти й призначити», додати селект цілі + «Опублікувати».
