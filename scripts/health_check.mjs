#!/usr/bin/env node
// ============================================================================
// health_check.mjs — ЛІНІЙКА проєкту TRAINER.
//
// Навіщо: перед перебиранням тек треба мати чим МІРЯТИ. Знімаємо показник ДО
// робіт, і після КОЖНОГО кроку доводимо, що нічого не зникло й не зламалось.
//
// ТІЛЬКИ ЧИТАННЯ. Нічого не змінює, крім файлу відбитка (і то лише за прямою
// вказівкою --save-baseline). Секретів не читає й не друкує.
//
//   node scripts/health_check.mjs --save-baseline   # зняти відбиток «як є»
//   node scripts/health_check.mjs                   # звірити з відбитком
//   node scripts/health_check.mjs --json            # машинний вивід
//
// Код виходу: 0 = все зелене, 1 = є червоне.
// ============================================================================
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const BASELINE = join(ROOT, 'scripts', 'health-baseline.json');
const JSON_OUT = process.argv.includes('--json');
const SAVE = process.argv.includes('--save-baseline');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const rows = [];
const add = (group, name, ok, detail) => rows.push({ group, name, ok, detail });

const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { maxBuffer: 1 << 28 }).toString('utf8');

// Що вважаємо «проєктом»: те, що знає git, плюс власні скрипти лінійки.
function trackedFiles() {
  const out = git('ls-files', '-z').split('\0').filter(Boolean);
  const extra = ['scripts/health_check.mjs'].filter((p) => existsSync(join(ROOT, p)) && !out.includes(p));
  return [...out, ...extra].sort();
}

// ── 1. ВІДБИТКИ ─────────────────────────────────────────────────────────────
// Ключ — ВМІСТ файлу, не шлях. Тоді переїзд видно як «переїхав», а не як
// «зник і зʼявився». Саме це й потрібно, коли перебираємо теки.
function fingerprint() {
  const m = {};
  for (const rel of trackedFiles()) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
    const buf = readFileSync(abs);
    m[rel] = { sha: sha(buf), bytes: buf.length };
  }
  return m;
}

// ⚠️ ПАСТКА, на якій цей чек уже спіткнувся (і мовчав, коли мусив кричати):
// у проєкті є ПОБАЙТОВІ ДУБЛІКАТИ (archive/export-grekfit-admin/reference/… —
// копія apps/trainer/index.html). Якщо порівнювати спершу за вмістом, то зміна
// файлу виглядає як «переїзд», бо старий вміст усе ще лежить у копії.
// Тому порядок ЖОРСТКИЙ: спершу шлях, і лише для ЗНИКЛИХ шляхів шукаємо,
// чи не виринув їхній вміст в іншому місці (це і є справжній переїзд).
function compare(now, base) {
  const nowByHash = {};
  for (const [p, v] of Object.entries(now)) (nowByHash[v.sha] ||= []).push(p);

  const lost = [], moved = [], changed = [], added = [];
  const movedTo = new Set();

  for (const [p, v] of Object.entries(base)) {
    if (now[p]) {                                  // шлях на місці
      if (now[p].sha !== v.sha) changed.push(p);   // → вміст інший = ЗМІНА
      continue;
    }
    const where = (nowByHash[v.sha] || []).filter((q) => !base[q] || base[q].sha !== v.sha || !now[q]);
    const dest = (nowByHash[v.sha] || []).filter((q) => !base[q]);   // новий шлях цього вмісту
    if (dest.length) { moved.push(`${p} → ${dest.join(', ')}`); dest.forEach((q) => movedTo.add(q)); }
    else if (where.length || nowByHash[v.sha]) moved.push(`${p} → ${nowByHash[v.sha].join(', ')}`);
    else lost.push(p);                             // вмісту ніде немає = ВТРАТА
  }
  for (const p of Object.keys(now)) if (!base[p] && !movedTo.has(p)) added.push(p);

  return { lost, moved: [...new Set(moved)], changed, added };
}

// ── 2. СЕКРЕТИ: жодного ключа в тому, що піде в git ─────────────────────────
// Це вартовий перед заливкою на GitHub. Значень НЕ друкує — лише шлях і рядок.
const SECRET_RE = new RegExp([
  'eyJhbGciOi[A-Za-z0-9_-]{10,}',              // JWT (Supabase service_role / anon)
  'sk-ant-api[A-Za-z0-9_-]{15,}',              // Anthropic
  'sk-proj-[A-Za-z0-9_-]{15,}',                // OpenAI
  'ghp_[A-Za-z0-9]{30,}', 'github_pat_[A-Za-z0-9_]{30,}',
  'AIza[A-Za-z0-9_-]{30,}',                    // Google
  '[0-9]{9,10}:AA[A-Za-z0-9_-]{30,}',          // Telegram bot token
  '-----BEGIN [A-Z ]*PRIVATE KEY',
].join('|'));

const TEXTY = /\.(md|html|js|mjs|cjs|json|sql|ts|tsx|yml|yaml|toml|txt|sh|env|css)$/i;

function checkSecrets() {
  const hits = [];
  for (const rel of trackedFiles()) {
    if (!TEXTY.test(rel)) continue;
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, 'utf8').split('\n');
    lines.forEach((l, i) => { if (SECRET_RE.test(l)) hits.push(`${rel}:${i + 1}`); });
  }
  add('Секрети', 'у трекованих файлах немає ключів', hits.length === 0,
    hits.length ? `🔴 ЗНАЙДЕНО (значення не друкую): ${hits.join(', ')}` : `${trackedFiles().length} файлів чисті`);

  // Файли з секретами мусять лишатись поза git.
  for (const f of ['.dev-secrets.env', 'SECRETS-LOCAL.md']) {
    if (!existsSync(join(ROOT, f))) continue;
    let ignored = true;
    try { git('check-ignore', '-q', f); } catch { ignored = false; }
    add('Секрети', `${f} поза git`, ignored, ignored ? 'у .gitignore ✓' : '🔴 НЕ ігнорується — потрапить у коміт');
  }
}

// ── 3. АСЕТИ: локальні посилання ведуть на існуючі файли ────────────────────
const REF_RE = /(?:src|href)\s*=\s*"([^"]+)"/g;
const skipRef = (r) =>
  !r || /^(https?:|data:|blob:|mailto:|tel:|javascript:|about:|#|\/\/)/.test(r) ||
  r.includes('${') || r.includes('$') || r.includes('{') ||
  // Атрибути в цьому проєкті часто збираються конкатенацією рядків у JS:
  //   src="'+esc(c.tg_photo_url)+'"  → це НЕ шлях до файлу, а шматок коду.
  r.includes("'") || r.includes('+') || r.includes('(') ||
  /[<>\\^[\]|`]/.test(r) || r.trim() !== r || r.length > 200;

// Шляхи, які резолвить dev-server.mjs, а не файлова система поруч із HTML.
const SERVER_ROUTES = new Set(['/data-store.js', '/data-store.supabase.js', '/data-store.client.js', '/exercises.json']);

function checkAssets() {
  let broken = 0, total = 0;
  for (const rel of trackedFiles().filter((f) => f.endsWith('.html') && !f.startsWith('archive/'))) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    const refs = new Set();
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(src))) {
      const raw = m[1].split('?')[0].split('#')[0];
      if (!skipRef(raw)) refs.add(raw);
    }
    const bad = [];
    for (const ref of refs) {
      total++;
      if (SERVER_ROUTES.has(ref)) continue;               // віддає dev-server, не диск
      const base = ref.startsWith('/') ? ROOT : dirname(abs);
      const t = resolve(base, ref.replace(/^\//, ''));
      const ok = existsSync(t) && (statSync(t).isFile() || existsSync(join(t, 'index.html')));
      if (!ok) { bad.push(ref); broken++; }
    }
    add('Асети існують', rel, bad.length === 0,
      bad.length ? `🔴 нема: ${bad.join(', ')}` : `усі ${refs.size} посилань живі`);
  }
  add('Асети існують', 'ПІДСУМОК', broken === 0, `${total - broken}/${total} посилань ведуть на існуючі файли`);
}

// ── 4. ЗАПУСКОВІ ШЛЯХИ: те, на що вказує конфіг, має існувати ───────────────
// .claude/launch.json тримає конфігурації прев'ю. Якщо котрась вкаже на
// неіснуючий файл — прев'ю тихо помре, і без цієї перевірки ніхто не помітить.
function checkLaunchPaths() {
  const f = join(ROOT, '.claude', 'launch.json');
  if (!existsSync(f)) { add('Запускові шляхи', '.claude/launch.json', false, 'нема файлу'); return; }
  let cfg;
  try { cfg = JSON.parse(readFileSync(f, 'utf8')); }
  catch (e) { add('Запускові шляхи', '.claude/launch.json', false, `не парситься: ${e.message}`); return; }
  for (const c of cfg.configurations || []) {
    const script = (c.runtimeArgs || []).find((a) => /\.(mjs|js|cjs)$/.test(a));
    if (!script) continue;
    const ok = existsSync(join(ROOT, script));
    add('Запускові шляхи', c.name, ok, ok ? `${script} ✓` : `🔴 НЕМА: ${script}`);
  }
}

// ── 5. СИНТАКСИС JS ─────────────────────────────────────────────────────────
// ⚠️ Пастка: слово «<script>» трапляється всередині коментарів у великих HTML.
// Тому спершу ЗАМАЗУЄМО коментарі й <style> пробілами тієї ж довжини —
// зміщення символів зберігаються, і код беремо з оригіналу.
const maskNonCode = (s) => s
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => ' '.repeat(m.length))
  .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));

function checkSyntax() {
  const tmp = mkdtempSync(join(tmpdir(), 'tr-syn-'));
  try {
    const files = trackedFiles().filter((f) => !f.startsWith('archive/'));
    for (const rel of files.filter((f) => f.endsWith('.html'))) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue;
      const src = readFileSync(abs, 'utf8');
      const masked = maskNonCode(src);
      const blocks = [...masked.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
        .map((m) => [m[1], src.slice(m.index + m[0].indexOf('>') + 1, m.index + m[0].length - '</script>'.length)])
        .filter(([attrs]) => !/\bsrc\s*=/.test(attrs))
        .filter(([attrs]) => !/type\s*=\s*"(?!text\/javascript|module|application\/javascript)/.test(attrs));
      let bad = null;
      blocks.forEach(([attrs, code], i) => {
        if (bad) return;
        const p = join(tmp, `b${i}.${/type\s*=\s*"module"/.test(attrs) ? 'mjs' : 'js'}`);
        writeFileSync(p, code);
        try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); }
        catch (e) { bad = `блок #${i + 1}: ${String(e.stderr || e).split('\n').slice(1, 3).join(' ').trim().slice(0, 140)}`; }
      });
      add('Синтаксис JS', rel, !bad, bad || `${blocks.length} інлайн-скриптів парсяться`);
    }
    for (const rel of files.filter((f) => /\.(mjs|js)$/.test(f))) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue;
      try { execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' }); add('Синтаксис JS', rel, true, 'парситься'); }
      catch (e) { add('Синтаксис JS', rel, false, String(e.stderr || e).split('\n')[1]?.trim().slice(0, 140) || 'помилка'); }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ── 6. ЖИВИЙ ПРОГІН: dev-server має віддавати ті самі сторінки ──────────────
// Маркер — рядок, який мусить бути у відповіді. Порожня 200-ка не рахується.
const PAGES = [
  ['/',                       'Перемикач превʼю',  ['phone-frame', 'web-frame', 'stage']],
  ['/trainer/',               'Адмінка тренера',   ['botnav', 'view-clients', 'view-calendar']],
  ['/trainer/super.html',     'Супер-адмін',       ['TrainerOS', 'a-email', 'a-pass']],
  ['/index.html',             'Клієнтський апп',   ['bottom-nav', 'gf_']],
  ['/data-store.js',          'DataStore (mock)',  ['DataStore']],
  ['/exercises.json',         'База вправ',        ['[', '{']],
  ['/api/trainers',           'Mock API',          ['[', '{']],
];

async function checkPages() {
  const srv = join(ROOT, 'dev-server.mjs');
  if (!existsSync(srv)) { add('Живий прогін', 'dev-server.mjs', false, '🔴 нема dev-server.mjs'); return; }

  const PORT = 3810 + Math.floor(Math.random() * 60);
  const proc = spawn(process.execPath, [srv], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = [];
  proc.stderr.on('data', (d) => err.push(d.toString()));
  const up = await new Promise((res) => {
    const t = setTimeout(() => res(false), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(t); res(true); } });
    proc.on('exit', () => { clearTimeout(t); res(false); });
  });
  if (!up) { proc.kill(); add('Живий прогін', 'запуск dev-server', false, `сервер не піднявся: ${err.join('').slice(0, 200)}`); return; }
  add('Живий прогін', 'запуск dev-server', true, `слухає порт ${PORT}`);

  try {
    for (const [path, name, markers] of PAGES) {
      let st = 0, body = '';
      try { const r = await fetch(`http://127.0.0.1:${PORT}${path}`); st = r.status; body = await r.text(); }
      catch (e) { add('Живий прогін', name, false, `запит впав: ${e.message}`); continue; }
      const miss = markers.filter((m) => !body.includes(m));
      add('Живий прогін', name, st === 200 && miss.length === 0,
        st !== 200 ? `HTTP ${st}` : miss.length ? `HTTP 200, але НЕМА маркерів: ${miss.join(', ')}`
          : `HTTP 200, ${(body.length / 1024).toFixed(0)} КБ, маркери на місці`);
    }
    const r404 = await fetch(`http://127.0.0.1:${PORT}/такого-нема-98765.html`);
    add('Живий прогін', 'неіснуюче → 404', r404.status === 404, `HTTP ${r404.status}`);
  } finally {
    proc.kill('SIGTERM');   // гасимо СВІЙ процес за PID, а не pkill за шаблоном
  }
}

// ── Вивід ───────────────────────────────────────────────────────────────────
async function main() {
  const now = fingerprint();
  if (SAVE) {
    writeFileSync(BASELINE, JSON.stringify({ takenAt: new Date().toISOString(), files: now }, null, 2));
    console.log(`Відбиток збережено: ${relative(ROOT, BASELINE)} (${Object.keys(now).length} файлів)`);
  }
  if (existsSync(BASELINE)) {
    const base = JSON.parse(readFileSync(BASELINE, 'utf8')).files;
    const d = compare(now, base);
    add('Відбитки', 'вміст не втрачено', d.lost.length === 0,
      d.lost.length ? `🔴 ЗНИК ВМІСТ (${d.lost.length}): ${d.lost.slice(0, 8).join(', ')}${d.lost.length > 8 ? '…' : ''}`
        : `${Object.keys(base).length} файлів на місці`);
    add('Відбитки', 'переїзди', true, d.moved.length ? `${d.moved.length}: ${d.moved.slice(0, 6).join(' · ')}${d.moved.length > 6 ? '…' : ''}` : 'переїздів не було');
    // Зміна вмісту під час перебирання тек — червоне: файл мав переїхати
    // незайманим. Змінили навмисно — перезняти відбиток і сказати вголос.
    add('Відбитки', 'вміст не змінено', d.changed.length === 0,
      d.changed.length ? `🔴 ЗМІНИВСЯ ВМІСТ: ${d.changed.slice(0, 8).join(', ')}${d.changed.length > 8 ? '…' : ''}` : 'жоден файл не змінив вмісту');
    add('Відбитки', 'нові файли', true, d.added.length ? `${d.added.length}: ${d.added.slice(0, 6).join(', ')}${d.added.length > 6 ? '…' : ''}` : 'нових немає');
  } else {
    add('Відбитки', 'baseline', false, 'нема відбитка — запусти з --save-baseline');
  }

  checkSecrets();
  checkLaunchPaths();
  checkAssets();
  checkSyntax();
  await checkPages();

  const bad = rows.filter((r) => !r.ok);
  if (JSON_OUT) console.log(JSON.stringify({ ok: bad.length === 0, rows }, null, 2));
  else {
    let cur = '';
    for (const r of rows) {
      if (r.group !== cur) { cur = r.group; console.log(`\n── ${cur} ${'─'.repeat(Math.max(0, 56 - cur.length))}`); }
      console.log(`  ${r.ok ? '✅' : '❌'} ${r.name.padEnd(32)} ${r.detail}`);
    }
    console.log(bad.length ? `\n🔴 ЧЕРВОНЕ: ${bad.length} з ${rows.length} — ${bad.map((b) => b.name).join('; ')}\n`
      : `\n🟢 Усе зелене (${rows.length} перевірок).\n`);
  }
  process.exit(bad.length ? 1 : 0);
}

main();
