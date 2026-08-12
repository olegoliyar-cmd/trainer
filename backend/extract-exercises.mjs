// Витягує EXERCISE_DB з клієнтського index.html → backend/exercises.json
// (id, name, mg, type, embed_url). Перезапускати, якщо база вправ змінилась.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dir, '..', 'trainer-app', 'index.html'), 'utf8');

const marker = 'const EXERCISE_DB = {';
const start = html.indexOf(marker);
if (start < 0) { console.error('EXERCISE_DB not found'); process.exit(1); }
// brace-match from the opening {
let i = html.indexOf('{', start), depth = 0, end = i;
for (; i < html.length; i++) {
  const c = html[i];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const objText = html.slice(html.indexOf('{', start), end);
// eval як звичайний об'єктний літерал (значення — рядки/числа/масиви, без викликів)
const EXERCISE_DB = (0, eval)('(' + objText + ')');

const MG_LABELS = { chest:'Груди', back:'Спина', legs:'Ноги', shoulders:'Плечі', arms:'Руки',
  biceps:'Біцепс', triceps:'Трицепс', core:'Прес', full:'Все тіло', glutes:'Сідниці', cardio:'Кардіо',
  functional:'Функціонал', padl:'Падл', format:'Формат' };

const list = Object.values(EXERCISE_DB).map((e) => ({
  id: e.id, name: e.name, mg: e.mg || null, mg_label: MG_LABELS[e.mg] || 'Інше',
  type: e.mtype || e.type || 'weight_reps', dbl: e.dbl || null,
  embed_url: e.embed_url || '',
  weight_chips: e.weight_chips || null, reps_chips: e.reps_chips || null,
}));

writeFileSync(join(__dir, 'exercises.json'), JSON.stringify(list, null, 2));
console.log('Extracted', list.length, 'exercises → backend/exercises.json');
// групи для довідки
const byMg = {};
list.forEach((e) => { byMg[e.mg_label] = (byMg[e.mg_label] || 0) + 1; });
console.log('By muscle group:', byMg);
