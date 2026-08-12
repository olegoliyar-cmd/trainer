// ─────────────────────────────────────────────────────────────────────────
//  MOCK BACKEND — модель даних + операції для зв'язки тренер↔клієнт.
//  Дзеркалить майбутні таблиці Supabase. Персист у JSON-файл (backend/data.json).
//  Пізніше цей шар замінюється на реальний Supabase — фронти не міняються,
//  бо ходять через спільний data-store.js, який дивиться на /api.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dir, 'data.json');
const EXERCISES_FILE = join(__dir, 'exercises.json');

// Довідник вправ (витягнутий з EXERCISE_DB клієнта скриптом extract-exercises.mjs).
// + вправи, завантажені тренером (custom), додаються у db.custom_exercises.
let _exLib = null;
function exerciseLibrary() {
  if (!_exLib) { try { _exLib = JSON.parse(readFileSync(EXERCISES_FILE, 'utf8')); } catch { _exLib = []; } }
  return _exLib;
}

// Таблиці (мульти-тенант): усе, що належить тренеру, має trainer_id.
const EMPTY = {
  trainers: [],      // {id, slug, brand_name, trainer_name, photo_url, accent, telegram_chat_url, created_at}
  clients: [],       // {id, trainer_id, tg_user_id, name, sex, goal, level, weight, height, status, created_at}
  programs: [],      // {id, trainer_id, name, description, structure, is_template, created_at}
  assignments: [],   // {id, client_id, program_id, assigned_at}  ← поточна програма клієнта
  workout_logs: [],  // {id, client_id, date, day_key, exercise, sets, created_at}
  measurements: [],  // {id, client_id, date, weight, height, waist, chest, biceps, bodyfat}
  messages: [],      // {id, trainer_id, client_id, from, body, exercise_id, created_at}
  invites: [],       // {token, trainer_id, created_at, used_by_client_id}
  custom_exercises: [], // {id, trainer_id, name, mg, mg_label, type, embed_url, bunny_id, created_at} — завантажені тренером
  ex_overrides: [],  // {id, trainer_id, exercise_id, name?, mg?, mg_label?, type?, embed_url?, bunny_id?} — персональні правки БАЗОВИХ вправ
  payments: [],      // {id, trainer_id, client_id, amount, currency, date, period_until, method, coupon_code, note, created_at}
  coupons: [],       // {id, trainer_id, code, kind:'percent'|'amount', value, note, active, created_at}
  tasks: [],         // {id, trainer_id, client_id, title, due_date, done, created_at} — CRM-нагадування тренеру
  nutrition_logs: [], // {id, client_id, date, time, kind:'text'|'voice'|'photo', text, photo, kcal, protein, carbs, fat, reviewed, created_at}
};

let db = null;

function load() {
  if (db) return db;
  if (existsSync(DATA_FILE)) {
    try { db = JSON.parse(readFileSync(DATA_FILE, 'utf8')); }
    catch { db = structuredClone(EMPTY); }
  } else {
    db = structuredClone(EMPTY);
    seed(db);
    save();
  }
  // гарантуємо, що всі таблиці існують (на випадок старого файлу)
  for (const k of Object.keys(EMPTY)) if (!db[k]) db[k] = [];
  // м'яка міграція: старим клієнтам додаємо CRM/оплату поля-дефолти
  for (const t of db.trainers) {
    if (!Array.isArray(t.pipeline) || !t.pipeline.length) t.pipeline = structuredClone(DEFAULT_PIPELINE);
    if (!Array.isArray(t.exercise_groups) || !t.exercise_groups.length) t.exercise_groups = structuredClone(DEFAULT_GROUPS);
  }
  for (const c of db.clients) {
    if (c.segment == null) c.segment = c.status === 'active' ? 'active' : 'lead';
    if (c.paid_until === undefined) c.paid_until = null;
    if (c.plan_price === undefined) c.plan_price = null;
    // стадія воронки CRM (єдине джерело правди для сегмента)
    if (c.stage == null) c.stage = c.segment === 'active' ? 'active' : (c.segment === 'finished' ? 'paused' : 'new');
    if (c.stage === 'trial') c.stage = 'work';      // ремап старих ключів на нову воронку
    if (c.stage === 'finished') c.stage = 'done';
    if (c.contact === undefined) c.contact = null;
    if (c.source === undefined) c.source = null;
  }
  for (const tk of db.tasks) {
    if (tk.remind_offset === undefined) tk.remind_offset = tk.remind ? 'at' : 'none';
    if (tk.due_time === undefined) tk.due_time = null;
    if (tk.remind_at === undefined) tk.remind_at = null;
    if (tk.note === undefined) tk.note = '';
    if (tk.priority === undefined) tk.priority = 'normal';
  }
  return db;
}

function save() {
  if (!existsSync(__dir)) mkdirSync(__dir, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
const now = () => new Date().toISOString();

// Дефолтна воронка CRM (тренер може перейменовувати/додавати/видаляти стадії).
const DEFAULT_PIPELINE = [
  { key: 'new',     label: 'Заявка' },
  { key: 'contact', label: 'Контакт' },
  { key: 'work',    label: 'Робота' },
  { key: 'active',  label: 'Активний' },
  { key: 'paused',  label: 'Пауза' },
  { key: 'done',    label: 'Завершив' },
];
// Групи м'язів для бази вправ (тренер може додавати свої).
const DEFAULT_GROUPS = [
  { key: 'chest', label: 'Груди' }, { key: 'back', label: 'Спина' }, { key: 'legs', label: 'Ноги' },
  { key: 'shoulders', label: 'Плечі' }, { key: 'arms', label: 'Руки' }, { key: 'core', label: 'Прес' },
  { key: 'full', label: 'Все тіло' }, { key: 'functional', label: 'Функціонал' }, { key: 'cardio', label: 'Кардіо' },
];

// Bunny Stream embed з video id. Бібліотеку задамо своєю (зараз — приклад).
const BUNNY_LIBRARY = process.env.BUNNY_LIBRARY || '661139';
function bunnyEmbed(videoId) {
  return `<div style="position:relative;padding-top:56.25%;"><iframe src="https://player.mediadelivery.net/embed/${BUNNY_LIBRARY}/${videoId}?autoplay=true&loop=false&muted=true&preload=true&responsive=true" loading="lazy" style="border:0;position:absolute;top:0;height:100%;width:100%;" allow="accelerometer;gyroscope;autoplay;encrypted-media;picture-in-picture;" allowfullscreen="true"></iframe></div>`;
}

// ── SEED: демо-тренер + шаблон програми + демо-клієнт (без призначеної програми) ──
function seed(d) {
  const trainer = {
    id: 'tr_demo', slug: 'demo',
    brand_name: 'GREKFIT', trainer_name: 'Роман',
    photo_url: 'assets/trainer/demo.jpg',
    accent: { color: '#E8FF00', deep: '#C4D900', faint: 'rgba(232,255,0,.04)', glow: 'rgba(232,255,0,.12)', ring: 'rgba(232,255,0,.25)' },
    telegram_chat_url: 'https://t.me/grek_fit_app_bot',
    pipeline: structuredClone(DEFAULT_PIPELINE),
    exercise_groups: structuredClone(DEFAULT_GROUPS),
    created_at: now(),
  };
  d.trainers.push(trainer);

  // Шаблон програми (тренер може призначити його клієнту).
  // builtin_key → показуємо ПОВНИЙ оригінальний UI програми (вбудовані PROGRAMS
  // у клієнтському апі, напр. Романові тренування). structure — резерв на майбутнє
  // (коли тренер складатиме програму з нуля через адмінку).
  d.programs.push({
    id: 'pg_demo_hyp', trainer_id: trainer.id, is_template: true,
    name: 'Зал · чоловіки', description: 'Набір мʼязової маси',
    builtin_key: 'hypertrophy_m',
    structure: {
      days: {
        A: { name: 'Груди · Трицепс', exercises: [
          { exercise: 'Жим лежачи', sets: [{ reps: 10, weight: null }, { reps: 10, weight: null }, { reps: 8, weight: null }] },
          { exercise: 'Жим гантелей під кутом', sets: [{ reps: 12, weight: null }, { reps: 12, weight: null }, { reps: 10, weight: null }] },
          { exercise: 'Розгинання на трицепс', sets: [{ reps: 15, weight: null }, { reps: 15, weight: null }, { reps: 12, weight: null }] },
        ] },
        B: { name: 'Спина · Біцепс', exercises: [
          { exercise: 'Підтягування', sets: [{ reps: 8, weight: null }, { reps: 8, weight: null }, { reps: 6, weight: null }] },
          { exercise: 'Тяга штанги в нахилі', sets: [{ reps: 10, weight: null }, { reps: 10, weight: null }, { reps: 8, weight: null }] },
          { exercise: 'Згинання на біцепс', sets: [{ reps: 12, weight: null }, { reps: 12, weight: null }, { reps: 10, weight: null }] },
        ] },
        C: { name: 'Ноги · Плечі', exercises: [
          { exercise: 'Присідання', sets: [{ reps: 10, weight: null }, { reps: 10, weight: null }, { reps: 8, weight: null }] },
          { exercise: 'Жим ногами', sets: [{ reps: 12, weight: null }, { reps: 12, weight: null }, { reps: 10, weight: null }] },
          { exercise: 'Жим гантелей сидячи', sets: [{ reps: 12, weight: null }, { reps: 10, weight: null }, { reps: 10, weight: null }] },
        ] },
      },
    },
    created_at: now(),
  });

  // Решта програм Романа (його вбудований каталог у клієнтському апі).
  [
    { key: 'hypertrophy_f', name: 'Зал · жінки', desc: 'Форма, рельєф, естетика' },
    { key: 'strength', name: 'Сила', desc: 'Абсолютна сила та вибуховість' },
    { key: 'functional', name: 'Функціонал', desc: 'Швидкість, сила, витривалість' },
    { key: 'home', name: 'Домашні тренування', desc: 'Без обладнання, удома' },
    { key: 'paddle', name: 'Падл', desc: 'Менше травм, ефективніша гра' },
    { key: null, name: 'Бойові мистецтва', desc: 'Техніка, координація, кардіо' },
  ].forEach((p) => {
    d.programs.push({ id: 'pg_roman_' + (p.key || 'martial'), trainer_id: trainer.id, is_template: true,
      name: p.name, description: p.desc, builtin_key: p.key, structure: { days: {} }, created_at: now() });
  });

  // Демо-клієнт із УЖЕ призначеною програмою (щоб перемикач одразу показував
  // повну програму). Другого клієнта лишаємо «без програми» для контрасту.
  const paidUntil = new Date(Date.now() + 18 * 864e5).toISOString().slice(0, 10);
  d.clients.push({
    id: 'cl_demo', trainer_id: trainer.id, tg_user_id: null,
    name: 'Вася', sex: 'm', goal: 'gain', level: 'beginner',
    weight: 80, height: 182, status: 'active',
    segment: 'active', stage: 'active', contact: '@vasya', source: 'Instagram',
    paid_until: paidUntil, plan_price: 89, created_at: now(),
  });
  d.assignments.push({ id: 'as_demo', client_id: 'cl_demo', program_id: 'pg_demo_hyp', assigned_at: now() });
  // Демо-прогрес Васі: заміри в динаміці (точка А → точка Б) для екрана порівняння.
  const dISO = (back) => new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
  {
    const c = byId(d.clients, 'cl_demo');
    c.measurements = [
      { id: 'ms_seed3', date: dISO(2),  created_at: now(), weight: 84.5, waist: 88, chest: 104, hip: 98,  arm: 39.5, bodyfat: 21 },
      { id: 'ms_seed2', date: dISO(30), created_at: now(), weight: 82,   waist: 90, chest: 101, hip: 99,  arm: 38,   bodyfat: 23 },
      { id: 'ms_seed1', date: dISO(60), created_at: now(), weight: 79,   waist: 93, chest: 98,  hip: 100, arm: 36.5, bodyfat: 26 },
    ];
  }
  // Демо-тренування Васі — свіжі дати (відносно «сьогодні»), щоб аналітика тиждень/місяць
  // показувала план vs факт. Тиждень: A/B/C виконані; місяць додає ще один цикл.
  {
    const wk = [
      { back: 1,  day: 'День C · Ноги/Плечі',   ex: [['Присідання', [[10,80],[10,80],[8,85]]], ['Жим ногами', [[12,120],[12,120],[10,130]]], ['Жим гантелей сидячи', [[12,20],[10,22],[10,22]]]] },
      { back: 3,  day: 'День B · Спина/Біцепс',  ex: [['Підтягування', [[8,0],[8,0],[6,0]]], ['Тяга штанги в нахилі', [[10,60],[10,60],[8,65]]], ['Згинання на біцепс', [[12,15],[12,15],[10,16]]]] },
      { back: 6,  day: 'День A · Груди/Трицепс', ex: [['Жим лежачи', [[10,60],[10,60],[8,65]]], ['Жим гантелей під кутом', [[12,24],[12,24],[10,26]]], ['Розгинання на трицепс', [[15,25],[15,25],[12,30]]]] },
      { back: 9,  day: 'День C · Ноги/Плечі',   ex: [['Присідання', [[10,77],[10,77],[8,82]]], ['Жим ногами', [[12,115],[12,115],[10,125]]]] },
      { back: 11, day: 'День B · Спина/Біцепс',  ex: [['Тяга штанги в нахилі', [[10,57],[10,57],[8,62]]], ['Згинання на біцепс', [[12,14],[12,14],[10,15]]]] },
      { back: 13, day: 'День A · Груди/Трицепс', ex: [['Жим лежачи', [[10,57],[10,57],[8,62]]], ['Жим гантелей під кутом', [[12,22],[12,22],[10,24]]]] },
    ];
    wk.forEach((w, wi) => w.ex.forEach((e, ei) => d.workout_logs.push({
      id: 'wl_seed_' + wi + '_' + ei, client_id: 'cl_demo', date: dISO(w.back), day_key: null,
      day_name: w.day, exercise: e[0], sets: e[1].map((s) => ({ reps: s[0], weight: s[1] })), created_at: now(),
    })));
  }

  d.clients.push({
    id: 'cl_demo2', trainer_id: trainer.id, tg_user_id: null,
    name: 'Оксана', sex: 'f', goal: 'shape', level: 'mid',
    weight: 62, height: 168, status: 'invited',
    segment: 'lead', stage: 'new', contact: '@oksana', source: 'Рекомендація',
    paid_until: null, plan_price: null, created_at: now(),
  });

  // Демо-оплата, купон і задача — щоб розділ Оплата/CRM не був порожнім.
  d.payments.push({
    id: 'pay_demo', trainer_id: trainer.id, client_id: 'cl_demo',
    amount: 89, currency: 'USD', date: now().slice(0, 10), period_until: paidUntil,
    method: 'Карта', coupon_code: null, note: '', created_at: now(),
  });
  d.coupons.push({
    id: 'cpn_demo', trainer_id: trainer.id, code: 'START20',
    kind: 'percent', value: 20, note: 'Знижка на перший місяць', active: true, created_at: now(),
  });
  d.tasks.push({
    id: 'tsk_demo', trainer_id: trainer.id, client_id: 'cl_demo2',
    title: 'Написати Оксані — нагадати про оплату', due_date: now().slice(0, 10), done: false, created_at: now(),
  });
}

// ── Операції (те, що згодом стане REST/RPC у Supabase) ──────────────────────
const byId = (arr, id) => arr.find((x) => x.id === id) || null;

export const store = {
  reset() { db = structuredClone(EMPTY); seed(db); save(); return db; },

  // TRAINERS
  listTrainers() { return load().trainers; },
  getTrainer(id) { return byId(load().trainers, id); },
  createTrainer(input) {
    const t = { id: uid('tr'), slug: input.slug || uid('t'), accent: input.accent || null,
      brand_name: input.brand_name || 'FITCOACH', trainer_name: input.trainer_name || 'Тренер',
      photo_url: input.photo_url || null, telegram_chat_url: input.telegram_chat_url || null,
      pipeline: structuredClone(DEFAULT_PIPELINE), created_at: now() };
    load().trainers.push(t); save(); return t;
  },
  updateTrainer(id, patch) {
    const t = byId(load().trainers, id); if (!t) return null;
    ['brand_name', 'trainer_name', 'photo_url', 'telegram_chat_url', 'accent', 'pipeline', 'exercise_groups'].forEach((k) => { if (patch[k] != null) t[k] = patch[k]; });
    save(); return t;
  },

  // CLIENTS
  listClients(trainerId) { return load().clients.filter((c) => c.trainer_id === trainerId); },
  getClient(id) { return byId(load().clients, id); },
  createClient(trainerId, input) {
    const c = { id: uid('cl'), trainer_id: trainerId, tg_user_id: input.tg_user_id || null,
      name: input.name || 'Клієнт', sex: input.sex || null, goal: input.goal || null, level: input.level || null,
      weight: input.weight ?? null, height: input.height ?? null, status: 'invited',
      segment: input.segment || 'lead', stage: input.stage || 'new',
      contact: input.contact || null, source: input.source || null,
      paid_until: null, plan_price: input.plan_price ?? null, plan_currency: input.plan_currency || 'USD', created_at: now() };
    load().clients.push(c); save(); return c;
  },
  updateClient(id, patch) {
    const c = byId(load().clients, id); if (!c) return null;
    Object.assign(c, patch); save(); return c;
  },
  // Видалення клієнта з каскадом (усі його дані). У Supabase це буде ON DELETE CASCADE.
  deleteClient(id) {
    const d = load();
    const c = byId(d.clients, id); if (!c) return { ok: false };
    d.clients = d.clients.filter((x) => x.id !== id);
    d.assignments = d.assignments.filter((x) => x.client_id !== id);
    d.workout_logs = d.workout_logs.filter((x) => x.client_id !== id);
    d.measurements = d.measurements.filter((x) => x.client_id !== id);
    d.messages = d.messages.filter((x) => x.client_id !== id);
    d.payments = d.payments.filter((x) => x.client_id !== id);
    d.nutrition_logs = d.nutrition_logs.filter((x) => x.client_id !== id);
    d.tasks = d.tasks.filter((x) => x.client_id !== id);
    d.invites = d.invites.filter((x) => x.used_by_client_id !== id);
    save(); return { ok: true, id };
  },
  // Анкета (intake) клієнта — вкладена в client.profile.
  setClientProfile(id, profile) {
    const c = byId(load().clients, id); if (!c) return null;
    c.profile = Object.assign({}, c.profile || {}, profile || {});
    save(); return c;
  },
  // Фото прогресу: {id, date, pose:'front'|'left'|'right'|'back', note, thumb(dataURL)}
  addClientPhoto(id, input) {
    const c = byId(load().clients, id); if (!c) return null;
    if (!c.photos) c.photos = [];
    const p = { id: uid('ph'), date: input.date || now().slice(0, 10), pose: input.pose || 'front', note: input.note || '', thumb: input.thumb || '', created_at: now() };
    c.photos.unshift(p); save(); return p;
  },
  deleteClientPhoto(id, photoId) {
    const c = byId(load().clients, id); if (!c || !c.photos) return { ok: false };
    c.photos = c.photos.filter((p) => p.id !== photoId); save(); return { ok: true };
  },
  // Виміри в динаміці: {id, date, weight, waist, chest, hip, arm, thigh, bodyfat}
  addClientMeasurement(id, input) {
    const c = byId(load().clients, id); if (!c) return null;
    if (!c.measurements) c.measurements = [];
    const m = { id: uid('ms'), date: input.date || now().slice(0, 10), created_at: now() };
    ['weight', 'waist', 'chest', 'hip', 'arm', 'thigh', 'bodyfat'].forEach((k) => { if (input[k] != null && input[k] !== '') m[k] = Number(input[k]); });
    c.measurements.unshift(m); save(); return m;
  },
  deleteClientMeasurement(id, msId) {
    const c = byId(load().clients, id); if (!c || !c.measurements) return { ok: false };
    c.measurements = c.measurements.filter((m) => m.id !== msId); save(); return { ok: true };
  },

  // PROGRAMS
  listPrograms(trainerId) { return load().programs.filter((p) => p.trainer_id === trainerId); },
  getProgram(id) { return byId(load().programs, id); },
  createProgram(trainerId, input) {
    const p = { id: uid('pg'), trainer_id: trainerId, is_template: !!input.is_template,
      name: input.name || 'Програма', description: input.description || '',
      builtin_key: input.builtin_key || null,
      structure: input.structure || { weeks: 1, days: [] }, created_at: now() };
    load().programs.push(p); save(); return p;
  },
  updateProgram(id, patch) {
    const p = byId(load().programs, id); if (!p) return null;
    if (patch.name != null) p.name = patch.name;
    if (patch.description != null) p.description = patch.description;
    if (patch.structure != null) p.structure = patch.structure;
    if (patch.is_template != null) p.is_template = !!patch.is_template;
    p.updated_at = now(); save(); return p;
  },
  // Клон програми/шаблону → нова (персональна для клієнта або новий шаблон).
  cloneProgram(id, opts) {
    const src = byId(load().programs, id); if (!src) return null;
    const p = { id: uid('pg'), trainer_id: (opts && opts.trainer_id) || src.trainer_id,
      is_template: !!(opts && opts.is_template),
      name: (opts && opts.name) || src.name, description: src.description || '',
      builtin_key: src.builtin_key || null,
      structure: JSON.parse(JSON.stringify(src.structure || { weeks: 1, days: [] })), created_at: now() };
    load().programs.push(p); save(); return p;
  },
  listTemplates(trainerId) { return load().programs.filter((p) => p.trainer_id === trainerId && p.is_template); },
  // Скласти персональну програму клієнту й одразу призначити (create + assign).
  createClientProgram(clientId, input) {
    const c = byId(load().clients, clientId); if (!c) return null;
    const p = store.createProgram(c.trainer_id, { ...input, is_template: false });
    store.assignProgram(clientId, p.id);
    return p;
  },

  // ASSIGNMENTS (поточна програма клієнта)
  getAssignment(clientId) {
    const a = load().assignments.filter((x) => x.client_id === clientId).sort((x, y) => y.assigned_at.localeCompare(x.assigned_at))[0];
    return a || null;
  },
  assignProgram(clientId, programId) {
    const a = { id: uid('as'), client_id: clientId, program_id: programId, assigned_at: now() };
    load().assignments.push(a);
    const c = byId(load().clients, clientId); if (c && c.status === 'invited') c.status = 'active';
    save(); return a;
  },

  // INVITES (прив'язка клієнта до тренера)
  createInvite(trainerId) {
    const inv = { token: uid('inv'), trainer_id: trainerId, created_at: now(), used_by_client_id: null };
    load().invites.push(inv); save(); return inv;
  },
  getInvite(token) { return load().invites.find((i) => i.token === token) || null; },
  bindInvite(token, clientInput) {
    const inv = store.getInvite(token); if (!inv) return null;
    const c = store.createClient(inv.trainer_id, clientInput || {});
    inv.used_by_client_id = c.id; save(); return c;
  },

  // LOGS (клієнт логує → тренер бачить)
  listLogs(clientId) { return load().workout_logs.filter((l) => l.client_id === clientId).sort((a, b) => (b.date || '').localeCompare(a.date || '')); },
  createLog(clientId, input) {
    const l = { id: uid('lg'), client_id: clientId, date: input.date || now().slice(0, 10),
      day_key: input.day_key || null, day_name: input.day_name || null, exercise: input.exercise || null,
      sets: input.sets || [], created_at: now() };
    load().workout_logs.push(l); save(); return l;
  },
  deleteLog(id) { const a = load().workout_logs; const i = a.findIndex((l) => l.id === id); if (i < 0) return { ok: false }; a.splice(i, 1); save(); return { ok: true }; },

  // NUTRITION (клієнт фіксує їжу → тренер бачить; фото — до перевірки)
  listNutrition(clientId) { return load().nutrition_logs.filter((n) => n.client_id === clientId).sort((a, b) => ((b.date || '') + (b.time || '')).localeCompare((a.date || '') + (a.time || ''))); },
  addNutrition(clientId, input) {
    // Прийом їжі = слот (meal/snack) + перелік продуктів (кожен з грамами й КБЖУ).
    const items = Array.isArray(input.items) ? input.items.map((it) => ({
      name: it.name || 'Продукт', grams: it.grams ?? null,
      kcal: it.kcal ?? null, protein: it.protein ?? null, carbs: it.carbs ?? null, fat: it.fat ?? null,
    })) : [];
    const sum = items.reduce((a, it) => ({
      kcal: a.kcal + (Number(it.kcal) || 0), protein: a.protein + (Number(it.protein) || 0),
      carbs: a.carbs + (Number(it.carbs) || 0), fat: a.fat + (Number(it.fat) || 0),
    }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
    const has = items.length > 0;
    const n = { id: uid('nut'), client_id: clientId, date: input.date || now().slice(0, 10),
      time: input.time || now().slice(11, 16), slot: input.slot === 'snack' ? 'snack' : 'meal',
      slot_idx: input.slot_idx != null ? Number(input.slot_idx) : 0, label: input.label || null,
      kind: input.kind || 'text', text: input.text || '', photo: input.photo || null, items,
      kcal: input.kcal ?? (has ? Math.round(sum.kcal) : null),
      protein: input.protein ?? (has ? Math.round(sum.protein) : null),
      carbs: input.carbs ?? (has ? Math.round(sum.carbs) : null),
      fat: input.fat ?? (has ? Math.round(sum.fat) : null),
      reviewed: false, created_at: now() };
    load().nutrition_logs.unshift(n); save(); return n;
  },
  // Тренер перевірив харчування → фото видаляються (текст/КБЖУ лишаються), щоб БД не засмічувалась.
  reviewNutrition(clientId) {
    let purged = 0;
    for (const n of load().nutrition_logs) {
      if (n.client_id === clientId && !n.reviewed) { n.reviewed = true; if (n.photo) { n.photo = null; purged++; } }
    }
    save(); return { ok: true, purged };
  },
  deleteNutrition(id) {
    const arr = load().nutrition_logs; const i = arr.findIndex((n) => n.id === id);
    if (i < 0) return { ok: false }; arr.splice(i, 1); save(); return { ok: true };
  },

  // EXERCISES — бібліотека (спільна, з персональними оверрайдами) + завантажені тренером
  listExercises(trainerId) {
    const ovs = load().ex_overrides.filter((o) => o.trainer_id === trainerId);
    const ovMap = {}; ovs.forEach((o) => { ovMap[o.exercise_id] = o; });
    const lib = exerciseLibrary().map((e) => {
      const o = ovMap[e.id]; if (!o) return e;
      return { ...e,
        name: o.name != null ? o.name : e.name,
        mg: o.mg != null ? o.mg : e.mg,
        mg_label: o.mg_label != null ? o.mg_label : e.mg_label,
        type: o.type != null ? o.type : e.type,
        embed_url: o.embed_url != null ? o.embed_url : e.embed_url,
        edited: true };
    });
    const custom = load().custom_exercises.filter((e) => !trainerId || e.trainer_id === trainerId);
    return custom.concat(lib);
  },
  createExercise(trainerId, input) {
    // Завантажена тренером вправа. bunny_id — реальний після аплоуду на Bunny;
    // зараз (mock) embed_url може бути порожнім/плейсхолдером.
    const bunny = input.bunny_id || null;
    const e = {
      id: uid('exu'), trainer_id: trainerId, name: input.name || 'Вправа',
      mg: input.mg || null, mg_label: input.mg_label || 'Інше',
      type: input.type || 'weight_reps', bunny_id: bunny,
      embed_url: input.embed_url || (bunny ? bunnyEmbed(bunny) : ''),
      custom: true, created_at: now(),
    };
    load().custom_exercises.push(e); save(); return e;
  },
  updateExercise(id, patch) {
    const applyVideo = (obj) => {
      if (patch.bunny_id != null) { obj.bunny_id = patch.bunny_id; obj.embed_url = patch.embed_url || bunnyEmbed(patch.bunny_id); }
      else if (patch.embed_url != null) obj.embed_url = patch.embed_url;
    };
    // 1) Власна (завантажена) вправа — редагуємо напряму.
    const own = byId(load().custom_exercises, id);
    if (own) {
      ['name', 'mg', 'mg_label', 'type'].forEach((k) => { if (patch[k] != null) own[k] = patch[k]; });
      applyVideo(own); save(); return own;
    }
    // 2) Базова (бібліотечна) вправа — персональний оверрайд на тренера.
    const trainerId = patch.trainer_id;
    if (!trainerId) return { ok: false, error: 'no trainer_id' };
    let o = load().ex_overrides.find((x) => x.trainer_id === trainerId && x.exercise_id === id);
    if (!o) { o = { id: uid('ov'), trainer_id: trainerId, exercise_id: id }; load().ex_overrides.push(o); }
    ['name', 'mg', 'mg_label', 'type'].forEach((k) => { if (patch[k] != null) o[k] = patch[k]; });
    applyVideo(o); save(); return { ok: true, override: o };
  },
  deleteExercise(id) {
    const arr = load().custom_exercises;
    const i = arr.findIndex((e) => e.id === id);
    if (i < 0) return { ok: false };
    arr.splice(i, 1); save(); return { ok: true };
  },

  // ── PAYMENTS (оплати клієнтів) ──
  listPayments(trainerId) { return load().payments.filter((p) => p.trainer_id === trainerId).sort((a, b) => (b.date || '').localeCompare(a.date || '')); },
  listClientPayments(clientId) { return load().payments.filter((p) => p.client_id === clientId).sort((a, b) => (b.date || '').localeCompare(a.date || '')); },
  addPayment(clientId, input) {
    const c = byId(load().clients, clientId); if (!c) return null;
    const p = { id: uid('pay'), trainer_id: c.trainer_id, client_id: clientId,
      amount: input.amount != null && input.amount !== '' ? Number(input.amount) : null,
      currency: input.currency || 'USD', date: input.date || now().slice(0, 10),
      period_until: input.period_until || null, method: input.method || null,
      coupon_code: input.coupon_code || null, note: input.note || '', created_at: now() };
    load().payments.push(p);
    if (p.period_until) c.paid_until = p.period_until;      // оплачено до…
    if (c.segment !== 'finished') c.segment = 'active';     // платить → активний
    if (c.stage !== 'paused') c.stage = 'active';           // оплата рухає у «Активний»
    if (c.status === 'invited') c.status = 'active';
    save(); return p;
  },
  deletePayment(id) { const arr = load().payments; const i = arr.findIndex((p) => p.id === id); if (i < 0) return { ok: false }; arr.splice(i, 1); save(); return { ok: true }; },

  // ── COUPONS (купони знижок) ──
  listCoupons(trainerId) { return load().coupons.filter((c) => c.trainer_id === trainerId); },
  createCoupon(trainerId, input) {
    const c = { id: uid('cpn'), trainer_id: trainerId, code: String(input.code || '').toUpperCase().trim(),
      kind: input.kind === 'amount' ? 'amount' : 'percent', value: input.value != null ? Number(input.value) : 0,
      note: input.note || '', active: input.active !== false, created_at: now() };
    load().coupons.push(c); save(); return c;
  },
  updateCoupon(id, patch) {
    const c = byId(load().coupons, id); if (!c) return null;
    ['code', 'kind', 'value', 'note', 'active'].forEach((k) => { if (patch[k] != null) c[k] = patch[k]; });
    save(); return c;
  },
  deleteCoupon(id) { const arr = load().coupons; const i = arr.findIndex((c) => c.id === id); if (i < 0) return { ok: false }; arr.splice(i, 1); save(); return { ok: true }; },

  // ── TASKS (CRM-нагадування тренеру) ──
  listTasks(trainerId) { return load().tasks.filter((t) => t.trainer_id === trainerId).sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999')); },
  createTask(trainerId, input) {
    const t = { id: uid('tsk'), trainer_id: trainerId, client_id: input.client_id || null,
      title: input.title || 'Задача', note: input.note || '', due_date: input.due_date || null,
      due_time: input.due_time || null, priority: input.priority || 'normal',
      // Тривалість потрібна календарю: блок задачі можна тягнути за нижній край
      duration_min: input.duration_min || 30,
      remind_offset: input.remind_offset || 'none', remind_at: input.remind_at || null,
      done: false, created_at: now() };
    load().tasks.push(t); save(); return t;
  },
  updateTask(id, patch) {
    const t = byId(load().tasks, id); if (!t) return null;
    if (patch.title != null) t.title = patch.title;
    if (patch.note != null) t.note = patch.note;
    if ('due_date' in patch) t.due_date = patch.due_date;
    if ('due_time' in patch) t.due_time = patch.due_time;
    if (patch.duration_min != null) t.duration_min = patch.duration_min;
    if ('client_id' in patch) t.client_id = patch.client_id;
    if (patch.priority != null) t.priority = patch.priority;
    if (patch.remind_offset != null) t.remind_offset = patch.remind_offset;
    if ('remind_at' in patch) t.remind_at = patch.remind_at;
    if (patch.done != null) t.done = !!patch.done;
    save(); return t;
  },
  deleteTask(id) { const arr = load().tasks; const i = arr.findIndex((t) => t.id === id); if (i < 0) return { ok: false }; arr.splice(i, 1); save(); return { ok: true }; },

  // ── MEETINGS (у проді створюються Edge-функцією; тут — щоб календар був
  //    повністю робочим і локально: перетягування, зміна тривалості, скасування) ──
  updateMeeting(id, patch) {
    const db = load(); db.meetings = db.meetings || [];
    const m = byId(db.meetings, id); if (!m) return null;
    ['starts_at', 'duration_min', 'kind', 'link', 'note', 'status'].forEach((k) => { if (k in patch) m[k] = patch[k]; });
    save(); return m;
  },
  deleteMeeting(id) {
    const db = load(); db.meetings = db.meetings || [];
    const i = db.meetings.findIndex((m) => m.id === id); if (i < 0) return { ok: false };
    db.meetings.splice(i, 1); save(); return { ok: true };
  },

  // BUNDLES — зручні агрегати для фронтів (один запит = усе потрібне)
  clientBundle(clientId) {
    const c = store.getClient(clientId); if (!c) return null;
    const trainer = store.getTrainer(c.trainer_id);
    const a = store.getAssignment(clientId);
    const program = a ? store.getProgram(a.program_id) : null;
    return { client: c, trainer, assignedProgram: program };
  },
  trainerBundle(trainerId) {
    const t = store.getTrainer(trainerId); if (!t) return null;
    const clients = store.listClients(trainerId).map((c) => {
      const a = store.getAssignment(c.id);
      const program = a ? store.getProgram(a.program_id) : null;
      const logs = store.listLogs(c.id);
      const payCount = store.listClientPayments(c.id).length;
      return { ...c, assignedProgram: program ? { id: program.id, name: program.name } : null, logsCount: logs.length, paymentsCount: payCount };
    });
    const workout_logs = load().workout_logs.filter((l) => clients.some((c) => c.id === l.client_id));
    // Зустрічі — як у Supabase-бандлі (там вони вже є); у mock просто прокидаємо
    const meetings = (load().meetings || []).filter((m) => clients.some((c) => c.id === m.client_id));
    return { trainer: t, clients, programs: store.listPrograms(trainerId),
      payments: store.listPayments(trainerId), coupons: store.listCoupons(trainerId), tasks: store.listTasks(trainerId),
      workout_logs, meetings };
  },
};

export default store;
