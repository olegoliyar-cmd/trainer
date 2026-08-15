// ─────────────────────────────────────────────────────────────────────────
//  DEV-СЕРВЕР (один origin, без CORS-мороки):
//    /api/*      → mock-бекенд (backend/api.mjs)
//    /data-store.js → спільний DataStore-клієнт (для обох апів)
//    /trainer/*  → тренерська адмінка (apps/trainer/)
//    /           → прев'ю-перемикач (apps/client/preview.html)
//    решта       → клієнтський апп (apps/client/)
// ─────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import handleApi from './backend/api.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(ROOT, 'apps', 'client');
const TRAINER_DIR = join(ROOT, 'apps', 'trainer');
const PORT = Number(process.env.PORT) || 3210;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.ico': 'image/x-icon',
};

async function serveFile(res, baseDir, rel, indexFallback) {
  if (rel === '/' || rel === '') rel = indexFallback;
  const filePath = normalize(join(baseDir, rel));
  if (!filePath.startsWith(baseDir)) { res.writeHead(403).end('Forbidden'); return; }
  let target = filePath, info = null;
  try { info = await stat(filePath); } catch { info = null; }
  if (!info && !extname(filePath)) { target = `${filePath}.html`; try { info = await stat(target); } catch { info = null; } }
  if (info && info.isDirectory()) { target = join(filePath, 'index.html'); info = await stat(target).catch(() => null); }
  if (!info) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
  const data = await readFile(target);
  res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    // 1) API
    if (await handleApi(req, res)) return;

    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);

    // 2) спільний DataStore-клієнт (mock) + Supabase-свап + база вправ (для supabase-режиму)
    if (path === '/data-store.js') { return serveFile(res, ROOT, '/data-store.js', '/data-store.js'); }
    if (path === '/data-store.supabase.js') { return serveFile(res, ROOT, '/supabase/data-store.supabase.js', '/supabase/data-store.supabase.js'); }
    if (path === '/data-store.client.js') { return serveFile(res, ROOT, '/supabase/data-store.client.js', '/supabase/data-store.client.js'); }
    if (path === '/exercises.json') { return serveFile(res, ROOT, '/backend/exercises.json', '/backend/exercises.json'); }

    // 3) тренерська адмінка
    if (path === '/trainer' || path.startsWith('/trainer/')) {
      const rel = path.replace(/^\/trainer/, '') || '/';
      return serveFile(res, TRAINER_DIR, rel, '/index.html');
    }

    // 4) корінь → перемикач прев'ю (3 версії: клієнт·тел / тренер·тел / тренер·веб);
    //    решта шляхів — клієнтський апп із теки apps/client/.
    return serveFile(res, CLIENT_DIR, path, '/preview.html');
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`DEV server on http://localhost:${PORT}`);
  console.log(`  client  → http://localhost:${PORT}/           (iPhone 16 Pro frame)`);
  console.log(`  trainer → http://localhost:${PORT}/trainer/`);
  console.log(`  api     → http://localhost:${PORT}/api/trainers`);
});
