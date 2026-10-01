/** Sessions, membership and the per-request access context (user, workspace, role, permissions, websites). */
import { randomBytes } from 'node:crypto';
import { db, now } from './db.js';
import { ALL as ALL_PERMS } from './rbac.js';
import { cookies, secureReq, fail, ipOf, str } from './http.js';

export function newSession(res, req, userId, ws) {
  const tok = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,workspace_id,created,ip,ua,last_seen) VALUES(?,?,?,?,?,?,?)').run(tok, userId, ws, now(), ipOf(req), str(req.headers['user-agent'], 200), now());
  res.setHeader('Set-Cookie', `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secureReq(req) ? '; Secure' : ''}`);
}
export const clearSession = res => res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');

export const memberOf = (userId, ws) => db.prepare('SELECT m.*, r.name role_name, r.system role_system, r.permissions FROM members m JOIN roles r ON r.id=m.role_id WHERE m.user_id=? AND m.workspace_id=?').get(userId, ws);
export const firstWorkspace = userId => db.prepare('SELECT workspace_id FROM members WHERE user_id=? ORDER BY created LIMIT 1').get(userId)?.workspace_id ?? null;
export const rolePerms = roleId => { const r = db.prepare('SELECT permissions, system FROM roles WHERE id=?').get(roleId); return new Set(r?.system ? ALL_PERMS : JSON.parse(r?.permissions || '[]')); };
export const memberPerms = mem => new Set(mem.role_system ? ALL_PERMS : JSON.parse(mem.permissions));
export const isSubset = (a, b) => [...a].every(p => b.has(p));

/** Resolves the signed-in user, their current workspace, role, permissions and website access (or null). */
export function authCtx(req) {
  const tok = cookies(req).sid; if (!tok) return null;
  const sess = db.prepare('SELECT * FROM sessions WHERE token=?').get(tok); if (!sess) return null;
  if (!sess.last_seen || now() - sess.last_seen > 60_000) db.prepare('UPDATE sessions SET last_seen=?, ip=? WHERE token=?').run(now(), ipOf(req), tok);
  if (now() - sess.created > 30 * 86400_000) { db.prepare('DELETE FROM sessions WHERE token=?').run(tok); return null; }
  const user = db.prepare('SELECT id, name, email, platform_role, disabled FROM users WHERE id=?').get(sess.user_id); if (!user || user.disabled) return null;
  let ws = sess.workspace_id, mem = ws && memberOf(user.id, ws);
  if (!mem) { ws = firstWorkspace(user.id); mem = ws && memberOf(user.id, ws); db.prepare('UPDATE sessions SET workspace_id=? WHERE token=?').run(ws, tok); }
  if (!mem) return { user, tok, ws: null, perms: new Set(), siteIds: [], role: null };
  const all = db.prepare('SELECT id FROM sites WHERE workspace_id=? ORDER BY id').all(ws).map(r => r.id);
  const limited = mem.site_ids ? JSON.parse(mem.site_ids) : null;
  const w = db.prepare('SELECT suspended, suspended_reason FROM workspaces WHERE id=?').get(ws);
  return { user, tok, ws, perms: memberPerms(mem), role: { id: mem.role_id, name: mem.role_name }, siteLimit: limited,
    siteIds: limited ? all.filter(id => limited.includes(id)) : all, suspended: w.suspended ? (w.suspended_reason || 'Suspended by the platform') : null };
}

/** Workspace audit log. */
export function audit(ws, user, action, detail) {
  db.prepare('INSERT INTO audit(workspace_id,user_id,user_name,action,detail,created) VALUES(?,?,?,?,?,?)').run(ws, user?.id ?? null, user?.name ?? 'system', action, detail ? String(detail).slice(0, 500) : null, now());
}
export function platformAudit(user, action, detail) {
  db.prepare('INSERT INTO platform_audit(user_id,user_name,action,detail,created) VALUES(?,?,?,?,?)').run(user?.id ?? null, user?.name ?? 'system', action, detail ? String(detail).slice(0, 500) : null, now());
}

/** Members of a workspace who hold a permission (and, optionally, can access a website). */
export function membersWith(ws, perm, siteId = null) {
  return db.prepare('SELECT u.id, u.name, u.email, m.site_ids, r.permissions, r.system FROM members m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.workspace_id=? AND u.disabled=0').all(ws)
    .filter(r => (r.system || JSON.parse(r.permissions).includes(perm)) && (siteId == null || !r.site_ids || JSON.parse(r.site_ids).includes(siteId)));
}
export const platformAdmins = () => db.prepare("SELECT id, name, email FROM users WHERE platform_role='superadmin' AND disabled=0").all();

export const requirePerm = (ctx, ...perms) => { if (!perms.some(p => ctx.perms.has(p))) fail(403, `You don't have permission to do this (${perms.join(' or ')})`); };
