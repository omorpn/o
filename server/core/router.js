/**
 * Declarative router. Modules describe routes as data:
 *   { method: 'POST', path: '/api/conversations/:id/messages', auth: 'ws', perm: 'chats.reply', handler: async c => ({ ... }) }
 * auth: 'public' | 'user' (signed in) | 'ws' (member of an active workspace, module enabled) | 'platform' (platform admin)
 * perm: permission string or array (any of). match: { param: /regex/ } narrows which values a :param accepts. A handler returns a JSON-able object (sent as 200) or handles `c.res` itself.
 */
import { send, fail, readBody, readRaw, ipOf, str, toInt } from './http.js';
import { authCtx, audit } from './auth.js';
import { isEnabled, getModule, allModules } from './modules.js';
import { db } from './db.js';

let table = null;
function compile() {
  table = [];
  for (const mod of allModules()) for (const r of mod.routes) {
    const keys = [];
    const re = new RegExp('^' + r.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\?:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    table.push({ ...r, re, keys, methods: [].concat(r.method || 'GET') });
  }
}

/** Builds the per-request helper object handed to handlers. */
function makeCtx(req, res, url, params, auth) {
  let bodyPromise;
  const c = {
    req, res, url, params, query: url.searchParams, ip: ipOf(req), auth,
    me: auth?.user, ws: auth?.ws,
    body: (max = 200_000) => (bodyPromise ||= readBody(req, max)),
    /** Raw body (Buffer) for non-JSON payloads such as inbound email webhooks. Don't combine with body(). */
    raw: (max = 200_000) => readRaw(req, max),
    int: k => toInt(params[k]),
    q: (k, max = 200) => str(url.searchParams.get(k) || '', max),
    can: p => !!auth?.perms.has(p),
    need: (...perms) => { if (!perms.some(p => auth?.perms.has(p))) fail(403, `You don't have permission to do this (${perms.join(' or ')})`); },
    log: (action, detail) => audit(auth.ws, auth.user, action, detail),
    /** Website from ?site=, must be one the user can access. */
    siteParam: () => { const id = Number(url.searchParams.get('site')); if (!auth?.siteIds.includes(id)) fail(404, 'Website not found'); return id; },
    /** ?site= narrows to one website, otherwise every website the user can access. */
    scopeSites: () => (url.searchParams.get('site') ? [c.siteParam()] : auth.siteIds),
    inSites: ids => `(${ids.map(Number).join(',') || 'NULL'})`,
    moduleOn: key => isEnabled(auth?.ws, key),
  };
  return c;
}

export async function dispatch(req, res, url) {
  if (!table) compile();
  const path = url.pathname;
  let matchedPath = false;
  for (const r of table) {
    const m = path.match(r.re); if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    if (r.match && Object.entries(r.match).some(([k, re]) => !re.test(params[k]))) continue;
    matchedPath = true;
    if (!r.methods.includes(req.method)) continue;
    let auth = null;
    if (r.auth !== 'public') {
      auth = authCtx(req);
      if (!auth) fail(401, 'Not authenticated');
      if (r.auth === 'platform' && auth.user.platform_role !== 'superadmin') fail(403, 'Platform admins only');
      if (r.auth === 'ws') {
        if (!auth.ws) fail(403, 'You are not a member of any workspace. Create one to continue.');
        if (auth.suspended) fail(403, `This workspace is suspended: ${auth.suspended}. Contact support.`);
        if (!isEnabled(auth.ws, r.module)) fail(403, `The ${getModule(r.module).name} module is not enabled for this workspace.`, { module: r.module });
      }
    } else if (r.optionalAuth) auth = authCtx(req);
    const c = makeCtx(req, res, url, params, auth);
    if (r.perm) c.need(...[].concat(r.perm));
    const out = await r.handler(c);
    if (out !== undefined && !res.headersSent) send(res, 200, out);
    return true;
  }
  if (matchedPath) fail(405, 'Method not allowed');
  return false;
}

/** Route table summary for docs/debugging. */
export function routeList() {
  if (!table) compile();
  return table.map(r => ({ module: r.module, method: r.methods.join('|'), path: r.path, auth: r.auth, perm: r.perm || null }));
}
export { db };
