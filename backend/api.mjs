// ─────────────────────────────────────────────────────────────────────────
//  HTTP API поверх store.mjs. Дзеркалить майбутні Supabase REST/RPC-ендпоінти.
//  handleApi(req,res) повертає true, якщо шлях /api/* оброблено.
// ─────────────────────────────────────────────────────────────────────────
import store from './store.mjs';

function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}

// Маленький роутер: [method, regex, handler(params, body)]
const routes = [
  ['GET',   /^\/api\/trainers$/,                       ()      => store.listTrainers()],
  ['POST',  /^\/api\/trainers$/,                        (_p, b) => store.createTrainer(b)],
  ['GET',   /^\/api\/trainers\/([^/]+)$/,               (p)     => store.getTrainer(p[0])],
  ['PATCH', /^\/api\/trainers\/([^/]+)$/,               (p, b)  => store.updateTrainer(p[0], b)],
  ['GET',   /^\/api\/trainers\/([^/]+)\/bundle$/,       (p)     => store.trainerBundle(p[0])],
  ['GET',   /^\/api\/trainers\/([^/]+)\/clients$/,      (p)     => store.listClients(p[0])],
  ['POST',  /^\/api\/trainers\/([^/]+)\/clients$/,      (p, b)  => store.createClient(p[0], b)],
  ['GET',   /^\/api\/trainers\/([^/]+)\/programs$/,     (p)     => store.listPrograms(p[0])],
  ['POST',  /^\/api\/trainers\/([^/]+)\/programs$/,     (p, b)  => store.createProgram(p[0], b)],
  ['GET',   /^\/api\/trainers\/([^/]+)\/templates$/,    (p)     => store.listTemplates(p[0])],
  ['GET',   /^\/api\/trainers\/([^/]+)\/exercises$/,    (p)     => store.listExercises(p[0])],
  ['POST',  /^\/api\/trainers\/([^/]+)\/exercises$/,    (p, b)  => store.createExercise(p[0], b)],
  ['POST',  /^\/api\/trainers\/([^/]+)\/invites$/,      (p)     => store.createInvite(p[0])],

  ['PATCH', /^\/api\/exercises\/([^/]+)$/,              (p, b)  => store.updateExercise(p[0], b)],
  ['DELETE',/^\/api\/exercises\/([^/]+)$/,              (p)     => store.deleteExercise(p[0])],
  ['PATCH', /^\/api\/programs\/([^/]+)$/,               (p, b)  => store.updateProgram(p[0], b)],
  ['POST',  /^\/api\/programs\/([^/]+)\/clone$/,        (p, b)  => store.cloneProgram(p[0], b)],

  ['GET',   /^\/api\/invites\/([^/]+)$/,                (p)     => store.getInvite(p[0])],
  ['POST',  /^\/api\/invites\/([^/]+)\/bind$/,          (p, b)  => store.bindInvite(p[0], b)],

  ['GET',   /^\/api\/clients\/([^/]+)$/,                (p)     => store.getClient(p[0])],
  ['PATCH', /^\/api\/clients\/([^/]+)$/,                (p, b)  => store.updateClient(p[0], b)],
  ['DELETE',/^\/api\/clients\/([^/]+)$/,                (p)     => store.deleteClient(p[0])],
  ['GET',   /^\/api\/clients\/([^/]+)\/bundle$/,        (p)     => store.clientBundle(p[0])],
  ['POST',  /^\/api\/clients\/([^/]+)\/assign$/,        (p, b)  => store.assignProgram(p[0], b.program_id)],
  ['POST',  /^\/api\/clients\/([^/]+)\/program$/,       (p, b)  => store.createClientProgram(p[0], b)],
  ['PATCH', /^\/api\/clients\/([^/]+)\/profile$/,       (p, b)  => store.setClientProfile(p[0], b)],
  ['POST',  /^\/api\/clients\/([^/]+)\/photos$/,        (p, b)  => store.addClientPhoto(p[0], b)],
  ['DELETE',/^\/api\/clients\/([^/]+)\/photos\/([^/]+)$/, (p)   => store.deleteClientPhoto(p[0], p[1])],
  ['POST',  /^\/api\/clients\/([^/]+)\/measurements$/,  (p, b)  => store.addClientMeasurement(p[0], b)],
  ['DELETE',/^\/api\/clients\/([^/]+)\/measurements\/([^/]+)$/, (p) => store.deleteClientMeasurement(p[0], p[1])],
  ['GET',   /^\/api\/clients\/([^/]+)\/logs$/,          (p)     => store.listLogs(p[0])],
  ['POST',  /^\/api\/clients\/([^/]+)\/logs$/,          (p, b)  => store.createLog(p[0], b)],
  ['DELETE',/^\/api\/logs\/([^/]+)$/,                   (p)     => store.deleteLog(p[0])],
  ['GET',   /^\/api\/clients\/([^/]+)\/nutrition$/,     (p)     => store.listNutrition(p[0])],
  ['POST',  /^\/api\/clients\/([^/]+)\/nutrition$/,     (p, b)  => store.addNutrition(p[0], b)],
  ['POST',  /^\/api\/clients\/([^/]+)\/nutrition\/review$/, (p) => store.reviewNutrition(p[0])],
  ['DELETE',/^\/api\/nutrition\/([^/]+)$/,              (p)     => store.deleteNutrition(p[0])],

  // PAYMENTS / COUPONS / TASKS (оплата + CRM)
  ['GET',   /^\/api\/trainers\/([^/]+)\/payments$/,     (p)     => store.listPayments(p[0])],
  ['POST',  /^\/api\/clients\/([^/]+)\/payments$/,      (p, b)  => store.addPayment(p[0], b)],
  ['GET',   /^\/api\/clients\/([^/]+)\/payments$/,      (p)     => store.listClientPayments(p[0])],
  ['DELETE',/^\/api\/payments\/([^/]+)$/,               (p)     => store.deletePayment(p[0])],
  ['GET',   /^\/api\/trainers\/([^/]+)\/coupons$/,      (p)     => store.listCoupons(p[0])],
  ['POST',  /^\/api\/trainers\/([^/]+)\/coupons$/,      (p, b)  => store.createCoupon(p[0], b)],
  ['PATCH', /^\/api\/coupons\/([^/]+)$/,                (p, b)  => store.updateCoupon(p[0], b)],
  ['DELETE',/^\/api\/coupons\/([^/]+)$/,                (p)     => store.deleteCoupon(p[0])],
  ['GET',   /^\/api\/trainers\/([^/]+)\/tasks$/,        (p)     => store.listTasks(p[0])],
  ['POST',  /^\/api\/trainers\/([^/]+)\/tasks$/,        (p, b)  => store.createTask(p[0], b)],
  ['PATCH', /^\/api\/tasks\/([^/]+)$/,                  (p, b)  => store.updateTask(p[0], b)],
  ['DELETE',/^\/api\/tasks\/([^/]+)$/,                  (p)     => store.deleteTask(p[0])],
  ['PATCH', /^\/api\/meetings\/([^/]+)$/,               (p, b)  => store.updateMeeting(p[0], b)],
  ['DELETE',/^\/api\/meetings\/([^/]+)$/,               (p)     => store.deleteMeeting(p[0])],

  ['POST',  /^\/api\/dev\/reset$/,                      ()      => ({ ok: true, ...store.reset() && {} })],
];

export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  if (!path.startsWith('/api/') && path !== '/api') return false;

  if (req.method === 'OPTIONS') { send(res, 204, {}); return true; }

  for (const [method, re, fn] of routes) {
    if (req.method !== method) continue;
    const m = path.match(re);
    if (!m) continue;
    const params = m.slice(1);
    const body = (method === 'POST' || method === 'PATCH') ? await readBody(req) : {};
    try {
      const result = fn(params, body);
      if (result == null) { send(res, 404, { error: 'not found' }); return true; }
      send(res, method === 'POST' ? 201 : 200, result);
    } catch (e) {
      send(res, 500, { error: String(e && e.message || e) });
    }
    return true;
  }
  send(res, 404, { error: 'unknown api route', path });
  return true;
}

export default handleApi;
