/**
 * Chatly server entry point.
 *
 *   core/      shared foundations: database, HTTP helpers, router, auth & permissions, realtime hub,
 *              event bus, module registry, mail transport, text matching
 *   modules/   features. Each registers routes + event handlers through defineModule(); non-core
 *              modules can be enabled per workspace and limited per plan (see core/modules.js).
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from './core/db.js';
import { send, fail, HttpError } from './core/http.js';
import { dispatch } from './core/router.js';
import { allModules } from './core/modules.js';
import { UPLOAD_DIR, UPLOAD_TYPES } from './modules/livechat/service.js';

seed();

// Registration order is route precedence. Core first, then features.
await import('./modules/auth/index.js');
await import('./modules/workspace/index.js');
await import('./modules/livechat/index.js');
await import('./modules/notifications/index.js');
await import('./modules/platform/index.js');
await import('./modules/fraud/index.js');
await import('./modules/flows/index.js');
await import('./modules/chatbot/index.js');
await import('./modules/ai/index.js');
await import('./modules/triggers/index.js');
await import('./modules/contacts/index.js');
await import('./modules/analytics/index.js');
await import('./modules/spam/index.js');
await import('./modules/webhooks/index.js');
for (const m of allModules()) m.init?.();

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

async function serveUpload(res, url) {
  const name = path.basename(decodeURIComponent(url.pathname));
  const type = Object.keys(UPLOAD_TYPES).find(t => UPLOAD_TYPES[t] === name.split('.').pop());
  if (!/^[a-f0-9]{24}\.\w+$/.test(name) || !type) fail(404, 'Not found');
  try {
    const buf = await readFile(path.join(UPLOAD_DIR, name));
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.end(buf);
  } catch { fail(404, 'Not found'); }
}
async function serveStatic(req, res, url) {
  if (url.pathname.startsWith('/uploads/')) return serveUpload(res, url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/app' || rel === '/app/') rel = '/app/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) fail(403, 'Forbidden');
  try {
    if (!(await stat(file)).isFile()) throw 0;
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (rel === '/widget.js') headers['Access-Control-Allow-Origin'] = '*';
    if (rel === '/app/sw.js') headers['Service-Worker-Allowed'] = '/app/';
    res.writeHead(200, headers); res.end(await readFile(file));
  } catch { fail(404, 'Not found'); }
}

export const server = http.createServer(async (req, res) => {
  const isApi = (req.url || '').startsWith('/api/');
  try {
    const url = new URL(req.url, 'http://x');
    if (isApi) { if (!(await dispatch(req, res, url))) fail(404, 'Not found'); return; }
    return await serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return isApi ? send(res, e.code, { error: e.message, ...(e.extra || {}) }) : (res.writeHead(e.code, { 'Content-Type': 'text/plain' }), res.end(e.message));
    console.error(e); send(res, 500, { error: 'Internal error' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => console.log(`Chatly running → http://localhost:${port}  (dashboard: /app, demo site: /)  · ${allModules().length} modules loaded`));
}
