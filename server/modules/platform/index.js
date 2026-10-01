/** Platform console (operators): workspaces, users, plans & modules, sign-up switch, announcement, platform audit. */
import { randomBytes } from 'node:crypto';
import { db, now, getPlatform, setPlatform, hashPassword } from '../../core/db.js';
import { fail, str } from '../../core/http.js';
import { emit } from '../../core/events.js';
import { defineModule, allModules } from '../../core/modules.js';
import { audit, platformAudit } from '../../core/auth.js';
import { sendMail, mailConfigured } from '../../core/mail.js';
import { agentStreams, visitorStreams, kickUser, kickWorkspace } from '../../core/realtime.js';
import { suspendWorkspace } from '../fraud/engine.js';

const n = (q, ...a) => db.prepare(q).get(...a).n;
const wsOwner = id => db.prepare("SELECT u.email, u.name FROM members m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.workspace_id=? AND r.system=1 ORDER BY m.created LIMIT 1").get(id);
export function workspaceOut(w) {
  return { id: w.id, name: w.name, plan: w.plan, suspended: !!w.suspended, suspended_reason: w.suspended_reason, created: w.created, owner: wsOwner(w.id) || null,
    sites: n('SELECT COUNT(*) n FROM sites WHERE workspace_id=?', w.id), members: n('SELECT COUNT(*) n FROM members WHERE workspace_id=?', w.id),
    conversations: n('SELECT COUNT(*) n FROM conversations WHERE workspace_id=?', w.id),
    last_activity: db.prepare('SELECT MAX(updated) t FROM conversations WHERE workspace_id=?').get(w.id).t, agents_online: [...agentStreams].filter(s => s.ws === w.id).length };
}
const plansList = () => getPlatform().plans.split(',').map(x => x.trim()).filter(Boolean);
const loadWs = c => db.prepare('SELECT * FROM workspaces WHERE id=?').get(c.int('id')) || fail(404, 'Workspace not found');
const loadUser = c => db.prepare('SELECT * FROM users WHERE id=?').get(c.int('id')) || fail(404, 'User not found');
const log = (c, a, d) => platformAudit(c.me, a, d);

export default defineModule({
  key: 'platform', name: 'Platform console', description: 'Operator tools.', core: true, hidden: true,
  routes: [
    { method: 'GET', path: '/api/platform/overview', auth: 'platform', handler: () => {
      const day = new Date(); day.setHours(0, 0, 0, 0); const d0 = day.getTime();
      const signups = []; for (let i = 13; i >= 0; i--) { const a = d0 - i * 86400000; signups.push({ date: new Date(a).toISOString().slice(0, 10), workspaces: n('SELECT COUNT(*) n FROM workspaces WHERE created>=? AND created<?', a, a + 86400000), users: n('SELECT COUNT(*) n FROM users WHERE created>=? AND created<?', a, a + 86400000) }); }
      const top = db.prepare('SELECT workspace_id id, COUNT(*) n FROM conversations WHERE created>=? GROUP BY workspace_id ORDER BY n DESC LIMIT 5').all(d0 - 30 * 86400000)
        .map(r => ({ id: r.id, name: db.prepare('SELECT name FROM workspaces WHERE id=?').get(r.id)?.name, conversations: r.n }));
      return {
        workspaces: n('SELECT COUNT(*) n FROM workspaces'), suspended: n('SELECT COUNT(*) n FROM workspaces WHERE suspended=1'), users: n('SELECT COUNT(*) n FROM users'),
        sites: n('SELECT COUNT(*) n FROM sites'), installed: n('SELECT COUNT(*) n FROM sites WHERE last_seen_at IS NOT NULL'),
        conversations: n('SELECT COUNT(*) n FROM conversations'), conversationsToday: n('SELECT COUNT(*) n FROM conversations WHERE created>=?', d0),
        messagesToday: n('SELECT COUNT(*) n FROM messages WHERE created>=?', d0), visitorsOnline: visitorStreams.size,
        agentsOnline: new Set([...agentStreams].map(s => s.userId)).size, activeWorkspaces7d: n('SELECT COUNT(DISTINCT workspace_id) n FROM conversations WHERE updated>=?', d0 - 7 * 86400000),
        signups, plans: db.prepare('SELECT plan, COUNT(*) n FROM workspaces GROUP BY plan ORDER BY n DESC').all(), top, mail: mailConfigured(), ai: !!process.env.ANTHROPIC_API_KEY,
      };
    } },
    { method: 'GET', path: '/api/platform/workspaces', auth: 'platform', handler: c => {
      const q = c.q('q', 100), f = c.query.get('filter');
      let sql = 'SELECT * FROM workspaces w WHERE 1=1'; const args = [];
      if (q) { sql += ' AND (w.name LIKE ? OR w.id IN (SELECT m.workspace_id FROM members m JOIN users u ON u.id=m.user_id WHERE u.email LIKE ?) OR w.id IN (SELECT workspace_id FROM sites WHERE domain LIKE ? OR name LIKE ?))'; args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
      if (f === 'suspended') sql += ' AND w.suspended=1';
      if (f && f.startsWith('plan:')) { sql += ' AND w.plan=?'; args.push(f.slice(5)); }
      return { workspaces: db.prepare(sql + ' ORDER BY w.created DESC LIMIT 500').all(...args).map(workspaceOut) };
    } },
    { method: 'GET', path: '/api/platform/workspaces/:id', auth: 'platform', handler: c => {
      const w = loadWs(c);
      const members = db.prepare('SELECT u.id, u.name, u.email, u.last_login, u.disabled, r.name role FROM members m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.workspace_id=? ORDER BY r.system DESC, u.name').all(w.id);
      const sites = db.prepare('SELECT * FROM sites WHERE workspace_id=? ORDER BY id').all(w.id).map(s => ({ id: s.id, name: s.name, domain: s.domain, created: s.created, last_seen_at: s.last_seen_at, last_origin: s.last_origin,
        conversations: n('SELECT COUNT(*) n FROM conversations WHERE site_id=?', s.id) }));
      return { workspace: workspaceOut(w), members: members.map(u => ({ ...u, disabled: !!u.disabled })), sites,
        audit: db.prepare('SELECT user_name, action, detail, created FROM audit WHERE workspace_id=? ORDER BY id DESC LIMIT 30').all(w.id) };
    } },
    { method: 'PUT', path: '/api/platform/workspaces/:id', auth: 'platform', handler: async c => {
      const w = loadWs(c), b = await c.body(), changes = [];
      if ('plan' in b) { const plan = str(b.plan, 30).toLowerCase(); if (!plansList().includes(plan)) fail(400, 'Unknown plan'); db.prepare('UPDATE workspaces SET plan=? WHERE id=?').run(plan, w.id); changes.push('plan=' + plan); emit('workspace.plan_changed', { ws: w.id, plan }); }
      if ('name' in b) { const nm = str(b.name, 80); if (!nm) fail(400, 'Name is required'); db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(nm, w.id); changes.push('name=' + nm); }
      if ('suspended' in b) {
        if (b.suspended) { const reason = str(b.reason, 200) || 'Suspended by the platform'; suspendWorkspace(w.id, reason, c.me); changes.push('suspended: ' + reason); }
        else {
          db.prepare('UPDATE workspaces SET suspended=0, suspended_reason=NULL WHERE id=?').run(w.id);
          audit(w.id, { id: c.me.id, name: `${c.me.name} (platform)` }, 'workspace.reactivated', null); changes.push('reactivated');
          emit('workspace.reactivated', { ws: w.id });
        }
      }
      log(c, 'workspace.updated', `${w.name} (#${w.id}): ${changes.join(', ')}`);
      return { workspace: workspaceOut(db.prepare('SELECT * FROM workspaces WHERE id=?').get(w.id)) };
    } },
    { method: 'DELETE', path: '/api/platform/workspaces/:id', auth: 'platform', handler: async c => {
      const w = loadWs(c);
      if ((await c.body()).confirm !== w.name) fail(400, 'Type the workspace name to confirm deletion');
      kickWorkspace(w.id);
      db.prepare('UPDATE sessions SET workspace_id=NULL WHERE workspace_id=?').run(w.id);
      db.prepare('DELETE FROM workspaces WHERE id=?').run(w.id);
      log(c, 'workspace.deleted', `${w.name} (#${w.id})`); return {};
    } },
    { method: 'GET', path: '/api/platform/users', auth: 'platform', handler: c => {
      const q = c.q('q', 100);
      const rows = db.prepare(`SELECT u.id, u.name, u.email, u.created, u.last_login, u.disabled, u.platform_role, (SELECT COUNT(*) FROM members m WHERE m.user_id=u.id) workspaces
        FROM users u WHERE (?='' OR u.name LIKE ? OR u.email LIKE ?) ORDER BY u.created DESC LIMIT 500`).all(q, `%${q}%`, `%${q}%`);
      const online = new Set([...agentStreams].map(s => s.userId));
      return { users: rows.map(u => ({ ...u, disabled: !!u.disabled, online: online.has(u.id),
        memberships: db.prepare('SELECT w.id, w.name, r.name role FROM members m JOIN workspaces w ON w.id=m.workspace_id JOIN roles r ON r.id=m.role_id WHERE m.user_id=?').all(u.id) })) };
    } },
    { method: 'POST', path: '/api/platform/users/:id/reset-password', auth: 'platform', handler: async c => {
      const u = loadUser(c), temp = randomBytes(9).toString('base64url');
      db.prepare('UPDATE users SET pass=? WHERE id=?').run(hashPassword(temp), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); kickUser(u.id);
      log(c, 'user.password_reset', u.email);
      let emailed = false;
      if (mailConfigured()) { try { await sendMail({ to: u.email, subject: 'Your Chatly password was reset', text: `A platform administrator reset your password.\n\nTemporary password: ${temp}\n\nSign in and change it under Settings → My account.` }); emailed = true; } catch (e) { console.error('mail error:', e.message); } }
      return { temporaryPassword: emailed ? null : temp, emailed };
    } },
    { method: 'PUT', path: '/api/platform/users/:id', auth: 'platform', handler: async c => {
      const u = loadUser(c), b = await c.body(), changes = [];
      if (u.id === c.me.id && ('disabled' in b || 'platform_role' in b)) fail(400, "You can't change your own platform access");
      if ('disabled' in b) {
        db.prepare('UPDATE users SET disabled=? WHERE id=?').run(b.disabled ? 1 : 0, u.id); changes.push(b.disabled ? 'disabled' : 'enabled');
        if (b.disabled) { db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); kickUser(u.id); }
      }
      if ('platform_role' in b) {
        const role = b.platform_role === 'superadmin' ? 'superadmin' : null;
        if (!role && u.platform_role === 'superadmin' && n("SELECT COUNT(*) n FROM users WHERE platform_role='superadmin' AND disabled=0") <= 1) fail(400, 'The platform needs at least one active platform admin');
        db.prepare('UPDATE users SET platform_role=? WHERE id=?').run(role, u.id); changes.push(role ? 'made platform admin' : 'removed platform admin');
      }
      log(c, 'user.updated', `${u.email}: ${changes.join(', ')}`); return {};
    } },
    { method: 'GET', path: '/api/platform/settings', auth: 'platform', handler: () => ({ settings: getPlatform(), signupForcedOff: process.env.ALLOW_SIGNUP === '0' }) },
    { method: 'PUT', path: '/api/platform/settings', auth: 'platform', handler: async c => {
      const b = await c.body(), patch = {};
      if ('allowSignup' in b) patch.allowSignup = !!b.allowSignup;
      if ('announcement' in b) patch.announcement = str(b.announcement, 300);
      if ('plans' in b) { const plans = str(b.plans, 200).split(',').map(x => x.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')).filter(Boolean); if (!plans.length) fail(400, 'Add at least one plan'); patch.plans = [...new Set(plans)].join(','); }
      const before = getPlatform().announcement;
      setPlatform(patch); log(c, 'platform.settings', Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', '));
      if (patch.announcement && patch.announcement !== before) emit('platform.announcement', { text: patch.announcement, by: c.me });
      return { settings: getPlatform() };
    } },
    // --- plans × modules ---
    { method: 'GET', path: '/api/platform/plans', auth: 'platform', handler: () => {
      const map = getPlatform().planModules || {};
      const modules = allModules().filter(m => !m.hidden && !m.core).map(m => ({ key: m.key, name: m.name, description: m.description }));
      return { plans: plansList().map(p => ({ plan: p, modules: Array.isArray(map[p]) ? map[p] : modules.map(m => m.key), workspaces: n('SELECT COUNT(*) n FROM workspaces WHERE plan=?', p) })), modules };
    } },
    { method: 'PUT', path: '/api/platform/plans/:plan', auth: 'platform', handler: async c => {
      const plan = c.params.plan; if (!plansList().includes(plan)) fail(404, 'Unknown plan');
      const keys = new Set(allModules().filter(m => !m.hidden && !m.core).map(m => m.key));
      const list = (await c.body()).modules; if (!Array.isArray(list)) fail(400, 'modules must be a list');
      const map = { ...(getPlatform().planModules || {}), [plan]: [...new Set(list)].filter(k => keys.has(k)) };
      setPlatform({ planModules: map }); log(c, 'plan.modules', `${plan}: ${map[plan].join(', ') || '(none)'}`);
      return { plan, modules: map[plan] };
    } },
    { method: 'GET', path: '/api/platform/audit', auth: 'platform', handler: () => ({ entries: db.prepare('SELECT user_name, action, detail, created FROM platform_audit ORDER BY id DESC LIMIT 300').all() }) },
  ],
});
