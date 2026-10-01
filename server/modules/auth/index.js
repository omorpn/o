/** Accounts (core): sign-in, sign-up, profile, password, workspace switching. */
import { db, now, getPlatform, hashPassword, checkPassword, createWorkspace } from '../../core/db.js';
import { fail, str, limit, EMAIL, toInt } from '../../core/http.js';
import { emit } from '../../core/events.js';
import { defineModule, modulesFor } from '../../core/modules.js';
import { newSession, clearSession, firstWorkspace, memberOf, audit } from '../../core/auth.js';
import { PERMISSIONS } from '../../core/rbac.js';
import { mailConfigured } from '../../core/mail.js';
import * as fraud from '../fraud/engine.js';
import { siteOut } from '../workspace/index.js';
import { siteRow } from '../livechat/service.js';
import { logLogin, twoFactorChallenge, sendVerification } from './security.js';

export default defineModule({
  key: 'auth', name: 'Accounts', description: 'Sign-in, sign-up and profiles.', core: true, hidden: true,
  routes: [
    { method: 'GET', path: '/api/public/config', auth: 'public', handler: () => ({ signupEnabled: getPlatform().allowSignup, announcement: getPlatform().announcement }) },
    { method: 'POST', path: '/api/auth/login', auth: 'public', handler: async c => {
      const b = await c.body(), email = str(b.email, 200).toLowerCase(), ip = c.ip;
      const guard = fraud.loginGuard(email, ip);
      if (guard.locked) fail(429, `${guard.reason}. Try again${guard.retryInSec ? ` in ${Math.ceil(guard.retryInSec / 60)} min` : ' later'}.`);
      limit('login:' + ip, 10, 60_000);
      const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      if (!u || !checkPassword(String(b.password || ''), u.pass)) { fraud.loginFailed(email, ip); logLogin(c.req, ip, email, u?.id, false, 'wrong_password'); fail(401, 'Invalid email or password'); }
      fraud.loginSucceeded(u, ip);
      if (u.disabled) { logLogin(c.req, ip, email, u.id, false, 'disabled'); fail(403, 'This account has been disabled. Contact support.'); }
      const ticket = twoFactorChallenge(u, ip);
      if (ticket) return { twoFactor: true, ticket };
      logLogin(c.req, ip, email, u.id, true, 'password');
      db.prepare('UPDATE users SET last_login=? WHERE id=?').run(now(), u.id);
      newSession(c.res, c.req, u.id, firstWorkspace(u.id));
      return { ok: true };
    } },
    { method: 'POST', path: '/api/auth/signup', auth: 'public', handler: async c => {
      if (!getPlatform().allowSignup) fail(403, 'Sign-up is currently closed on this platform');
      limit('signup:' + c.ip, 5, 60 * 60_000);
      const b = await c.body();
      const name = str(b.name, 80), email = str(b.email, 200).toLowerCase(), pw = String(b.password || ''), wsName = str(b.workspace, 80) || `${name}'s workspace`;
      if (!name || !EMAIL.test(email)) fail(400, 'Your name and a valid email are required');
      if (pw.length < 8) fail(400, 'Password must be at least 8 characters');
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail(409, 'An account with this email already exists — sign in instead');
      const ip = c.ip;
      const signals = fraud.scoreSignup({ email, name, workspace: wsName, ip, ua: c.req.headers['user-agent'], honeypot: b.company_website, elapsedMs: b.elapsed });
      const pre = signals.reduce((a, x) => a + x.weight, 0);
      if (pre >= fraud.fraudSettings().blockThreshold && fraud.fraudSettings().fraudMode === 'enforce') {
        fraud.record({ kind: 'signup', signals, ip, email, summary: `Sign-up blocked: ${name} / ${wsName}` });
        fail(403, "We couldn't create your account. If you think this is a mistake, contact support.");
      }
      const uid = Number(db.prepare('INSERT INTO users(name,email,pass,created,signup_ip,last_ip,email_verified) VALUES(?,?,?,?,?,?,0)').run(name, email, hashPassword(pw), now(), ip, ip).lastInsertRowid);
      sendVerification(c.req, { id: uid, name, email });
      const { wsId } = createWorkspace(wsName, uid, str(b.site_name, 80) || 'My website', str(b.domain, 200) || null);
      fraud.record({ kind: 'signup', signals, workspaceId: wsId, userId: uid, ip, email, summary: `New workspace "${wsName}" by ${name}` });
      fraud.maybeAutoSuspend(wsId);
      audit(wsId, { id: uid, name }, 'workspace.created', wsName);
      emit('workspace.created', { ws: wsId, name: wsName, owner: { id: uid, name, email } });
      newSession(c.res, c.req, uid, wsId);
      return { ok: true };
    } },
    { method: 'POST', path: '/api/auth/logout', auth: 'public', optionalAuth: true, handler: c => {
      if (c.auth) db.prepare('DELETE FROM sessions WHERE token=?').run(c.auth.tok);
      clearSession(c.res); return {};
    } },
    { method: 'GET', path: '/api/me', auth: 'user', handler: c => {
      const { me, ws, auth } = c;
      const workspaces = db.prepare('SELECT w.id, w.name, r.name role FROM members m JOIN workspaces w ON w.id=m.workspace_id JOIN roles r ON r.id=m.role_id WHERE m.user_id=? ORDER BY w.name').all(me.id);
      const sec = db.prepare('SELECT email_verified, totp_enabled FROM users WHERE id=?').get(me.id);
      return { user: { id: me.id, name: me.name, email: me.email, platform_role: me.platform_role || null, email_verified: !!sec.email_verified, two_factor: !!sec.totp_enabled },
        workspace: ws ? { ...db.prepare('SELECT id, name, plan FROM workspaces WHERE id=?').get(ws), suspended: auth.suspended } : null,
        workspaces, announcement: getPlatform().announcement, role: auth.role, permissions: [...auth.perms], modules: ws ? modulesFor(ws) : [],
        sites: auth.siteIds.map(id => siteOut(siteRow(id))), catalog: PERMISSIONS, aiConfigured: !!process.env.ANTHROPIC_API_KEY, mailConfigured: mailConfigured(), signupEnabled: getPlatform().allowSignup };
    } },
    { method: 'PUT', path: '/api/me', auth: 'user', handler: async c => {
      const name = str((await c.body()).name, 80); if (!name) fail(400, 'Name is required');
      db.prepare('UPDATE users SET name=? WHERE id=?').run(name, c.me.id); return {};
    } },
    { method: 'POST', path: '/api/me/password', auth: 'user', handler: async c => {
      const b = await c.body(), u = db.prepare('SELECT * FROM users WHERE id=?').get(c.me.id);
      if (!checkPassword(String(b.current || ''), u.pass)) fail(403, 'Current password is wrong');
      if (String(b.password || '').length < 8) fail(400, 'Password must be at least 8 characters');
      db.prepare('UPDATE users SET pass=? WHERE id=?').run(hashPassword(b.password), c.me.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token!=?').run(c.me.id, c.auth.tok);
      return {};
    } },
    { method: 'POST', path: '/api/workspaces', auth: 'user', handler: async c => {
      limit('ws:' + c.me.id, 10, 60 * 60_000);
      const b = await c.body(), name = str(b.name, 80); if (!name) fail(400, 'Workspace name is required');
      const { wsId } = createWorkspace(name, c.me.id, str(b.site_name, 80) || 'My website', str(b.domain, 200) || null);
      audit(wsId, c.me, 'workspace.created', name);
      db.prepare('UPDATE sessions SET workspace_id=? WHERE token=?').run(wsId, c.auth.tok);
      return { id: wsId };
    } },
    { method: 'POST', path: '/api/workspaces/switch', auth: 'user', handler: async c => {
      const id = toInt((await c.body()).id);
      if (!memberOf(c.me.id, id)) fail(404, 'Workspace not found');
      db.prepare('UPDATE sessions SET workspace_id=? WHERE token=?').run(id, c.auth.tok);
      return {};
    } },
  ],
});
