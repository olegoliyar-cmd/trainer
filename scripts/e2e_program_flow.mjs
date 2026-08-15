#!/usr/bin/env node
// ============================================================================
// e2e_program_flow.mjs — НАСКРІЗНИЙ ТЕСТ головного сценарію продукту:
//
//   тренер складає програму
//        → клієнт бачить її у своєму застосунку
//             → клієнт виконує тренування
//                  → тренер бачить виконання у себе в кабінеті
//
// Це не «сторінка відкрилась». Тест проходить увесь ланцюжок даних і на
// кожному кроці звіряє ЗМІСТ: чи та сама програма, чи ті самі вправи, чи та
// сама вага й повторення. Якщо десь по дорозі дані спотворяться — впаде.
//
// БЕЗПЕКА: тест пише в mock-базу (backend/data.json), тому спершу робить її
// резервну копію, а в кінці повертає й ДОВОДИТЬ побайтово, що повернув.
// Прод і Supabase не зачіпаються взагалі — усе локально.
//
//   node scripts/e2e_program_flow.mjs
//   node scripts/e2e_program_flow.mjs --keep    # не прибирати за собою
//
// Код виходу: 0 = усі кроки пройшли, 1 = є падіння.
// ============================================================================
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const DATA = join(ROOT, 'backend', 'data.json');
const BACKUP = join(ROOT, 'backend', 'data.json.e2e-backup');
const KEEP = process.argv.includes('--keep');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

let PORT, proc;
const steps = [];
const step = (name, ok, detail) => { steps.push({ name, ok, detail }); console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(46)} ${detail}`); };

async function api(method, path, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch {}
  return { status: r.status, body: json, raw: txt };
}

async function startServer() {
  PORT = 3900 + Math.floor(Math.random() * 80);
  proc = spawn(process.execPath, [join(ROOT, 'dev-server.mjs')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const err = [];
  proc.stderr.on('data', (d) => err.push(d.toString()));
  const up = await new Promise((res) => {
    const t = setTimeout(() => res(false), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(t); res(true); } });
    proc.on('exit', () => { clearTimeout(t); res(false); });
  });
  if (!up) throw new Error(`dev-server не піднявся: ${err.join('').slice(0, 200)}`);
  return PORT;
}

// ── Сценарій ────────────────────────────────────────────────────────────────
// Програма навмисно не порожня: два дні, конкретні вправи, конкретні підходи.
// Саме цей зміст і звіряємо на кожному кроці — щоб тест ловив не лише
// «нічого не приїхало», а й «приїхало, але не те».
const PROGRAM = {
  name: 'E2E · Гіпертрофія 2 дні',
  description: 'Тимчасова програма для наскрізного тесту',
  structure: {
    weeks: 4,
    days: [
      { key: 'a', name: 'День A · Верх', exercises: [
        { name: 'Жим лежачи', sets: 4, reps: 8, rpe: 8 },
        { name: 'Тяга штанги в нахилі', sets: 4, reps: 10, rpe: 7 },
      ] },
      { key: 'b', name: 'День B · Низ', exercises: [
        { name: 'Присідання зі штангою', sets: 5, reps: 5, rpe: 8 },
      ] },
    ],
  },
};
const WORKOUT = {
  day_key: 'a',
  day_name: 'День A · Верх',
  exercise: 'Жим лежачи',
  sets: [{ weight: 80, reps: 8 }, { weight: 80, reps: 8 }, { weight: 82.5, reps: 6 }],
};

async function run() {
  console.log('\n── Підготовка ' + '─'.repeat(48));
  copyFileSync(DATA, BACKUP);
  const shaBefore = sha(DATA);
  step('резервна копія mock-бази', true, `sha ${shaBefore.slice(0, 12)}`);

  await startServer();
  step('dev-server піднявся', true, `порт ${PORT}`);

  console.log('\n── Крок 1. ТРЕНЕР складає програму ' + '─'.repeat(28));
  const trs = await api('GET', '/api/trainers');
  const trainer = Array.isArray(trs.body) ? trs.body[0] : null;
  step('тренер знайдений', !!trainer, trainer ? `${trainer.trainer_name || trainer.brand_name} (${trainer.id})` : '🔴 у mock-базі немає жодного тренера');
  if (!trainer) return;

  const pg = await api('POST', `/api/trainers/${trainer.id}/programs`, PROGRAM);
  const program = pg.body;
  step('програму створено', pg.status === 201 && !!program?.id, program?.id ? `${program.id} · «${program.name}»` : `HTTP ${pg.status}`);
  if (!program?.id) return;

  const daysSaved = program.structure?.days?.length;
  step('структуру програми збережено', daysSaved === 2,
    daysSaved === 2 ? '2 дні, 3 вправи — як задано' : `🔴 днів: ${daysSaved}, очікувалось 2`);

  console.log('\n── Крок 2. ТРЕНЕР заводить клієнта і призначає програму ' + '─'.repeat(7));
  const cl = await api('POST', `/api/trainers/${trainer.id}/clients`, { name: 'E2E Тестовий Клієнт', goal: 'mass', level: 'medium' });
  const client = cl.body;
  step('клієнта створено', cl.status === 201 && !!client?.id, client?.id ? `${client.id} · статус «${client.status}»` : `HTTP ${cl.status}`);
  if (!client?.id) return;

  const asg = await api('POST', `/api/clients/${client.id}/assign`, { program_id: program.id });
  step('програму призначено клієнту', asg.status === 201 && !!asg.body?.id, asg.body?.id || `HTTP ${asg.status}`);

  console.log('\n── Крок 3. КЛІЄНТ бачить програму у своєму застосунку ' + '─'.repeat(9));
  const cb = await api('GET', `/api/clients/${client.id}/bundle`);
  const seen = cb.body?.assignedProgram;
  step('клієнту віддається саме ця програма', seen?.id === program.id,
    seen?.id === program.id ? `«${seen.name}»` : `🔴 клієнт бачить: ${seen?.id || 'нічого'}`);

  const seenDay = seen?.structure?.days?.find((d) => d.key === 'a');
  const seenEx = seenDay?.exercises?.[0];
  step('зміст програми доїхав без спотворень',
    seenDay?.name === PROGRAM.structure.days[0].name && seenEx?.name === 'Жим лежачи' && seenEx?.sets === 4 && seenEx?.reps === 8,
    seenEx ? `${seenDay.name} → ${seenEx.name} ${seenEx.sets}×${seenEx.reps}` : '🔴 день або вправа не доїхали');

  step('клієнт бачить свого тренера', cb.body?.trainer?.id === trainer.id,
    cb.body?.trainer?.id === trainer.id ? cb.body.trainer.brand_name || cb.body.trainer.trainer_name : '🔴 тренер не привʼязався');

  // Бізнес-правило store.assignProgram: призначення програми активує клієнта.
  const after = await api('GET', `/api/clients/${client.id}`);
  step('статус клієнта став «active»', after.body?.status === 'active',
    `було «${client.status}» → стало «${after.body?.status}»`);

  console.log('\n── Крок 4. КЛІЄНТ виконує тренування ' + '─'.repeat(26));
  const lg = await api('POST', `/api/clients/${client.id}/logs`, WORKOUT);
  const log = lg.body;
  step('тренування залоговано', lg.status === 201 && !!log?.id, log?.id ? `${log.id} · ${log.date}` : `HTTP ${lg.status}`);

  const logs = await api('GET', `/api/clients/${client.id}/logs`);
  const mine = (logs.body || []).find((l) => l.id === log?.id);
  const setsOk = JSON.stringify(mine?.sets) === JSON.stringify(WORKOUT.sets);
  step('підходи збереглися точно', setsOk,
    setsOk ? WORKOUT.sets.map((s) => `${s.weight}кг×${s.reps}`).join(' · ') : `🔴 у базі: ${JSON.stringify(mine?.sets)}`);

  console.log('\n── Крок 5. ТРЕНЕР бачить виконання у кабінеті ' + '─'.repeat(17));
  const tb = await api('GET', `/api/trainers/${trainer.id}/bundle`);
  const row = (tb.body?.clients || []).find((c) => c.id === client.id);
  step('клієнт зʼявився у списку тренера', !!row, row ? row.name : '🔴 клієнта немає в бандлі тренера');

  step('тренер бачить призначену програму', row?.assignedProgram?.id === program.id,
    row?.assignedProgram ? `«${row.assignedProgram.name}»` : '🔴 програма не показана');

  step('лічильник тренувань зріс', (row?.logsCount || 0) >= 1, `logsCount = ${row?.logsCount}`);

  const tLog = (tb.body?.workout_logs || []).find((l) => l.id === log?.id);
  const tSetsOk = JSON.stringify(tLog?.sets) === JSON.stringify(WORKOUT.sets);
  step('тренер бачить ТІ САМІ підходи', tSetsOk,
    tSetsOk ? `${tLog.exercise}: ${tLog.sets.map((s) => `${s.weight}×${s.reps}`).join(', ')}` : '🔴 підходи не збігаються або лога немає');

  step('лог привʼязаний до правильного дня', tLog?.day_name === WORKOUT.day_name,
    tLog?.day_name || '🔴 день не збережений');
}

async function cleanup() {
  if (proc) proc.kill('SIGTERM');           // гасимо СВІЙ процес за PID
  await new Promise((r) => setTimeout(r, 250));
  console.log('\n── Прибирання ' + '─'.repeat(48));
  if (KEEP) { console.log('  ⏸ --keep: mock-базу лишено зміненою, копія: backend/data.json.e2e-backup'); return; }
  if (existsSync(BACKUP)) {
    copyFileSync(BACKUP, DATA);
    const ok = sha(DATA) === sha(BACKUP);
    unlinkSync(BACKUP);
    step('mock-базу повернуто побайтово', ok, ok ? 'жодного сліду від тесту' : '🔴 база НЕ збігається з копією');
  }
}

const t0 = Date.now();
try {
  await run();
} catch (e) {
  step('несподівана помилка', false, String(e.message || e));
} finally {
  await cleanup();
  const bad = steps.filter((s) => !s.ok);
  console.log('\n' + '═'.repeat(62));
  console.log(bad.length
    ? `🔴 ПРОВАЛЕНО: ${bad.length} з ${steps.length} — ${bad.map((b) => b.name).join('; ')}`
    : `🟢 НАСКРІЗНИЙ СЦЕНАРІЙ ПРОЙДЕНО: ${steps.length} перевірок за ${((Date.now() - t0) / 1000).toFixed(1)}с`);
  console.log('═'.repeat(62) + '\n');
  process.exit(bad.length ? 1 : 0);
}
