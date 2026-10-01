/** Workspace administration (core): websites, team members, roles & permissions, modules, audit log. */
import { db, now, hashPassword, createSite, newSiteKey } from '../../core/db.js';
import { fail, str, EMAIL, toInt } from '../../core/http.js';
import { emit } from '../../core/events.js';
import { defineModule, modulesFor, getModule, setEnabled, planAllows, planLimit } from '../../core/modules.js';
import { memberOf, rolePerms, isSubset } from '../../core/auth.js';
import { ALL as ALL_PERMS, cleanPerms } from '../../core/rbac.js';
import { agentStreams, kickUser, agentStatus } from '../../core/realtime.js';
import { siteRow } from '../livechat/service.js';

export const siteOut = s => ({ id: s.id, name: s.name, domain: s.domain, site_key: s.site_key, created: s.created, last_seen_at: s.last_seen_at, last_origin: s.last_origin,
  last_error: s.last_error_at > (s.last_seen_at || 0) ? s.last_error : null, last_error_at: s.last_error_at });
const roleOut = r => ({ id: r.id, name: r.name, system: !!r.system, permissions: r.system ? ALL_PERMS : JSON.parse(r.permissions), members: db.prepare('SELECT COUNT(*) n FROM members WHERE role_id=?').get(r.id).n });
const ownerCount = ws => db.prepare("SELECT COUNT(*) n FROM members m JOIN roles r ON r.id=m.role_id WHERE m.workspace_id=? AND r.system=1").get(ws).n;

function cleanSiteIds(ws, list) {
  if (list == null) return null;
  if (!Array.isArray(list)) fail(400, 'site_ids must be a list');
  const valid = new Set(db.prepare('SELECT id FROM sites WHERE workspace_id=?').all(ws).map(r => r.id));
  const ids = [...new Set(list.map(Number))].filter(id => valid.has(id));
  if (!ids.length) fail(400, 'Pick at least one website, or give access to all');
  return ids;
}
function assertCanGrant(c, roleId) {
  const r = db.prepare('SELECT * FROM roles WHERE id=? AND workspace_id=?').get(roleId, c.ws);
  if (!r) fail(400, 'Role not found');
  if (!isSubset(rolePerms(r.id), c.auth.perms)) fail(403, "You can't grant a role with more permissions than your own");
  return r;
}
function loadSite(c) {
  const s = siteRow(c.int('id'));
  if (!s || s.workspace_id !== c.ws || !c.auth.siteIds.includes(s.id)) fail(404, 'Website not found');
  return s;
}
/** Loads a member the current user is allowed to manage. */
function loadMember(c) {
  const uid = c.int('id'), mem = memberOf(uid, c.ws); if (!mem) fail(404, 'Member not found');
  if (uid === c.me.id) fail(400, "You can't change your own access — ask another admin");
  if (!isSubset(rolePerms(mem.role_id), c.auth.perms)) fail(403, 'This person has permissions you do not have, so you cannot change them');
  const isOwner = db.prepare('SELECT system FROM roles WHERE id=?').get(mem.role_id).system;
  return { uid, mem, isOwner, target: db.prepare('SELECT name, email FROM users WHERE id=?').get(uid) };
}
async function roleFields(c, exceptId = 0) {
  const b = await c.body(), name = str(b.name, 40); if (!name) fail(400, 'Role name is required');
  const perms = cleanPerms(b.permissions);
  if (!perms.length) fail(400, 'Pick at least one permission');
  if (!isSubset(new Set(perms), c.auth.perms)) fail(403, "You can't give a role permissions you don't have yourself");
  if (db.prepare('SELECT 1 FROM roles WHERE workspace_id=? AND lower(name)=lower(?) AND id!=?').get(c.ws, name, exceptId)) fail(409, 'A role with that name already exists');
  return { name, perms };
}
function loadRole(c) {
  const role = db.prepare('SELECT * FROM roles WHERE id=? AND workspace_id=?').get(c.int('id'), c.ws); if (!role) fail(404, 'Role not found');
  if (role.system) fail(400, 'The Owner role always has every permission and cannot be changed');
  if (!isSubset(rolePerms(role.id), c.auth.perms)) fail(403, 'This role has permissions you do not have, so you cannot change it');
  return role;
}

export default defineModule({
  key: 'workspace', name: 'Workspace', description: 'Websites, team, roles and audit log.', core: true, hidden: true,
  routes: [
    { method: 'PUT', path: '/api/workspace', auth: 'ws', perm: 'workspace.manage', handler: async c => {
      const name = str((await c.body()).name, 80); if (!name) fail(400, 'Name is required');
      db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(name, c.ws); c.log('workspace.renamed', name); return {};
    } },
    // --- modules ---
    { method: 'GET', path: '/api/modules', auth: 'ws', handler: c => ({ modules: modulesFor(c.ws) }) },
    { method: 'PUT', path: '/api/modules/:key', auth: 'ws', perm: ['workspace.manage', 'settings.manage'], handler: async c => {
      const mod = getModule(c.params.key); if (!mod || mod.hidden) fail(404, 'Unknown module');
      if (mod.core) fail(400, `${mod.name} is part of the core and can't be turned off`);
      const enabled = !!(await c.body()).enabled;
      const plan = db.prepare('SELECT plan FROM workspaces WHERE id=?').get(c.ws).plan;
      if (enabled && !planAllows(plan, mod.key)) fail(402, `${mod.name} is not included in your ${plan} plan`);
      setEnabled(c.ws, mod.key, enabled); c.log(enabled ? 'module.enabled' : 'module.disabled', mod.name);
      emit('module.toggled', { ws: c.ws, module: mod.key, enabled });
      return { modules: modulesFor(c.ws) };
    } },
    // --- websites ---
    { method: 'GET', path: '/api/sites', auth: 'ws', handler: c => ({ sites: c.auth.siteIds.map(id => siteOut(siteRow(id))) }) },
    { method: 'POST', path: '/api/sites', auth: 'ws', perm: 'sites.manage', handler: async c => {
      const b = await c.body(), name = str(b.name, 80); if (!name) fail(400, 'Website name is required');
      const maxSites = planLimit(c.ws, 'sites');
      if (maxSites && db.prepare('SELECT COUNT(*) n FROM sites WHERE workspace_id=?').get(c.ws).n >= maxSites) fail(402, `Your plan includes ${maxSites} website(s). Upgrade under Settings → Billing to add more.`, { limit: 'sites' });
      const id = createSite(c.ws, name, str(b.domain, 200) || null); c.log('site.created', name);
      return { site: siteOut(siteRow(id)) };
    } },
    { method: 'POST', path: '/api/sites/:id/rotate-key', auth: 'ws', perm: 'sites.manage', handler: c => {
      const s = loadSite(c); db.prepare('UPDATE sites SET site_key=? WHERE id=?').run(newSiteKey(), s.id); c.log('site.key_rotated', s.name);
      return { site: siteOut(siteRow(s.id)) };
    } },
    { method: 'PUT', path: '/api/sites/:id', auth: 'ws', perm: 'sites.manage', handler: async c => {
      const s = loadSite(c), b = await c.body(), name = str(b.name, 80); if (!name) fail(400, 'Website name is required');
      db.prepare('UPDATE sites SET name=?, domain=? WHERE id=?').run(name, str(b.domain, 200) || null, s.id); c.log('site.updated', name); return {};
    } },
    { method: 'DELETE', path: '/api/sites/:id', auth: 'ws', perm: 'sites.manage', handler: c => {
      const s = loadSite(c);
      if (db.prepare('SELECT COUNT(*) n FROM sites WHERE workspace_id=?').get(c.ws).n <= 1) fail(400, "You can't delete the only website in a workspace");
      db.prepare('DELETE FROM sites WHERE id=?').run(s.id); c.log('site.deleted', s.name); return {};
    } },
    // --- team ---
    { method: 'GET', path: '/api/members', auth: 'ws', handler: c => {
      const rows = db.prepare('SELECT u.id, u.name, u.email, m.role_id, r.name role, r.system, m.site_ids, r.permissions FROM members m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.workspace_id=? ORDER BY u.name').all(c.ws);
      const online = new Set([...agentStreams].filter(s => s.ws === c.ws).map(s => s.userId));
      return { members: rows.map(r => ({ id: r.id, name: r.name, email: c.can('team.manage') ? r.email : undefined, role_id: r.role_id, role: r.role,
        site_ids: r.site_ids ? JSON.parse(r.site_ids) : null, can_reply: !!r.system || JSON.parse(r.permissions).includes('chats.reply'), online: online.has(r.id), status: agentStatus(r.id),
        departments: db.prepare('SELECT d.id FROM department_members dm JOIN departments d ON d.id=dm.department_id WHERE dm.user_id=? AND d.workspace_id=?').all(r.id, c.ws).map(x => x.id) })) };
    } },
    { method: 'POST', path: '/api/members', auth: 'ws', perm: 'team.manage', handler: async c => {
      const b = await c.body(), email = str(b.email, 200).toLowerCase(), name = str(b.name, 80);
      if (!EMAIL.test(email)) fail(400, 'A valid email is required');
      const role = assertCanGrant(c, toInt(b.role_id)), siteIds = cleanSiteIds(c.ws, b.site_ids);
      const seats = planLimit(c.ws, 'seats');
      if (seats && db.prepare('SELECT COUNT(*) n FROM members WHERE workspace_id=?').get(c.ws).n >= seats) fail(402, `Your plan includes ${seats} teammate seat(s). Upgrade under Settings → Billing to add more.`, { limit: 'seats' });
      let u = db.prepare('SELECT * FROM users WHERE email=?').get(email), created = false;
      if (!u) {
        if (!name) fail(400, 'Name is required for a new account');
        if (String(b.password || '').length < 8) fail(400, 'Temporary password must be at least 8 characters');
        u = { id: Number(db.prepare('INSERT INTO users(name,email,pass,created,email_verified) VALUES(?,?,?,?,0)').run(name, email, hashPassword(String(b.password)), now()).lastInsertRowid), name, email };
        created = true;
      } else if (memberOf(u.id, c.ws)) fail(409, 'This person is already in the workspace');
      db.prepare('INSERT INTO members(user_id,workspace_id,role_id,site_ids,created) VALUES(?,?,?,?,?)').run(u.id, c.ws, role.id, siteIds ? JSON.stringify(siteIds) : null, now());
      c.log('member.added', `${email} as ${role.name}`);
      emit('member.added', { ws: c.ws, user: { id: u.id, name: u.name, email }, role: role.name, by: c.me, created });
      return { created };
    } },
    { method: 'PUT', path: '/api/members/:id', auth: 'ws', perm: 'team.manage', handler: async c => {
      const { uid, isOwner, target } = loadMember(c), b = await c.body();
      const role = assertCanGrant(c, toInt(b.role_id)), siteIds = cleanSiteIds(c.ws, b.site_ids);
      if (isOwner && !role.system && ownerCount(c.ws) <= 1) fail(400, 'A workspace needs at least one Owner');
      db.prepare('UPDATE members SET role_id=?, site_ids=? WHERE user_id=? AND workspace_id=?').run(role.id, siteIds ? JSON.stringify(siteIds) : null, uid, c.ws);
      c.log('member.updated', `${target.email} → ${role.name}${siteIds ? ` (${siteIds.length} sites)` : ''}`); kickUser(uid, c.ws);
      return {};
    } },
    { method: 'DELETE', path: '/api/members/:id', auth: 'ws', perm: 'team.manage', handler: c => {
      const { uid, isOwner, target } = loadMember(c);
      if (isOwner && ownerCount(c.ws) <= 1) fail(400, 'A workspace needs at least one Owner');
      db.prepare('DELETE FROM members WHERE user_id=? AND workspace_id=?').run(uid, c.ws);
      db.prepare('UPDATE conversations SET assignee_id=NULL WHERE workspace_id=? AND assignee_id=?').run(c.ws, uid);
      db.prepare('UPDATE sessions SET workspace_id=NULL WHERE user_id=? AND workspace_id=?').run(uid, c.ws);
      c.log('member.removed', target.email); kickUser(uid, c.ws);
      return {};
    } },
    // --- roles ---
    { method: 'GET', path: '/api/roles', auth: 'ws', perm: ['team.manage', 'roles.manage'], handler: c => ({ roles: db.prepare('SELECT * FROM roles WHERE workspace_id=? ORDER BY system DESC, id').all(c.ws).map(roleOut) }) },
    { method: 'POST', path: '/api/roles', auth: 'ws', perm: 'roles.manage', handler: async c => {
      const r = await roleFields(c);
      const id = db.prepare('INSERT INTO roles(workspace_id,name,permissions) VALUES(?,?,?)').run(c.ws, r.name, JSON.stringify(r.perms)).lastInsertRowid;
      c.log('role.created', r.name); return { id };
    } },
    { method: 'PUT', path: '/api/roles/:id', auth: 'ws', perm: 'roles.manage', handler: async c => {
      const role = loadRole(c), r = await roleFields(c, role.id);
      db.prepare('UPDATE roles SET name=?, permissions=? WHERE id=?').run(r.name, JSON.stringify(r.perms), role.id);
      c.log('role.updated', `${r.name}: ${r.perms.join(', ')}`);
      for (const u of db.prepare('SELECT user_id FROM members WHERE role_id=?').all(role.id)) kickUser(u.user_id, c.ws);
      return {};
    } },
    { method: 'DELETE', path: '/api/roles/:id', auth: 'ws', perm: 'roles.manage', handler: c => {
      const role = loadRole(c);
      if (db.prepare('SELECT COUNT(*) n FROM members WHERE role_id=?').get(role.id).n) fail(400, 'Move everyone off this role before deleting it');
      db.prepare('DELETE FROM roles WHERE id=?').run(role.id); c.log('role.deleted', role.name); return {};
    } },
    { method: 'GET', path: '/api/audit', auth: 'ws', perm: 'audit.view', handler: c => ({ entries: db.prepare('SELECT user_name, action, detail, created FROM audit WHERE workspace_id=? ORDER BY id DESC LIMIT 300').all(c.ws) }) },
  ],
});
