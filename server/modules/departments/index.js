/**
 * Departments & routing. Teams such as Sales or Support, and automatic assignment of new and handed-over
 * conversations to an available teammate:
 *   manual       nobody is auto-assigned (the whole team is notified)
 *   round_robin  the available agent who was routed a chat longest ago
 *   least_busy   the available agent with the fewest open chats (ties: longest since last routed)
 * "Available" = connected to the dashboard, status not Away, allowed to reply on that website, below the
 * workspace's max concurrent chats, and — when the chat has a department — a member of that department.
 * Chats that find nobody wait in the queue and are handed out when an agent comes online, turns available,
 * or closes a chat.
 */
import { db, now, getWsSettings, setWsSettings } from '../../core/db.js';
import { fail, str, toInt } from '../../core/http.js';
import { on, emit } from '../../core/events.js';
import { defineModule, isEnabled } from '../../core/modules.js';
import { memberOf, memberPerms } from '../../core/auth.js';
import { availableAgents } from '../../core/realtime.js';
import { getConv, emitConv, routing } from '../livechat/service.js';

export const MODES = ['manual', 'round_robin', 'least_busy'];
export const departmentMemberIds = id => db.prepare('SELECT user_id FROM department_members WHERE department_id=?').all(id).map(r => r.user_id);
const openLoad = (ws, userId) => db.prepare("SELECT COUNT(*) n FROM conversations WHERE workspace_id=? AND assignee_id=? AND status='open' AND snoozed_until IS NULL").get(ws, userId).n;

/** Picks an agent for the conversation and assigns it. Returns the user id, or null when it stays in the queue. */
export function routeConversation(conv) {
  if (!conv || conv.assignee_id || conv.status !== 'open' || conv.spam || conv.bot_active) return null;
  const ws = conv.workspace_id;
  if (!isEnabled(ws, 'departments')) return null;
  const cfg = getWsSettings(ws); if (cfg.assignmentMode === 'manual') return null;
  let ids = [...availableAgents(ws, conv.site_id)];
  if (conv.department_id) { const dm = new Set(departmentMemberIds(conv.department_id)); ids = ids.filter(id => dm.has(id)); }
  const cands = ids.map(id => ({ id, load: openLoad(ws, id), last: db.prepare('SELECT last_routed FROM members WHERE user_id=? AND workspace_id=?').get(id, ws)?.last_routed || 0 }))
    .filter(a => !cfg.maxChats || a.load < cfg.maxChats);
  if (!cands.length) return null;
  cands.sort(cfg.assignmentMode === 'least_busy' ? (a, b) => a.load - b.load || a.last - b.last || a.id - b.id : (a, b) => a.last - b.last || a.id - b.id);
  const pick = cands[0].id;
  // guarded update: never overwrite an assignment made in the meantime
  if (!db.prepare('UPDATE conversations SET assignee_id=? WHERE id=? AND assignee_id IS NULL').run(pick, conv.id).changes) return null;
  db.prepare('UPDATE members SET last_routed=? WHERE user_id=? AND workspace_id=?').run(now(), pick, ws);
  const fresh = getConv(conv.id);
  emitConv(fresh);
  emit('conversation.assigned', { conv: fresh, assigneeId: pick, by: null, auto: true });
  return pick;
}

/** Hands queued (unassigned, waiting for a human) conversations to whoever is free now. */
export function drainQueue(ws) {
  if (!ws || !isEnabled(ws, 'departments') || getWsSettings(ws).assignmentMode === 'manual') return 0;
  let n = 0;
  for (const c of db.prepare("SELECT * FROM conversations WHERE workspace_id=? AND status='open' AND assignee_id IS NULL AND bot_active=0 AND spam=0 AND snoozed_until IS NULL ORDER BY needs_human DESC, created LIMIT 200").all(ws)) {
    if (routeConversation(c)) n++;
  }
  return n;
}

const deptOut = d => ({ id: d.id, name: d.name, description: d.description || '', color: d.color, public: !!d.public, position: d.position, members: departmentMemberIds(d.id),
  open: db.prepare("SELECT COUNT(*) n FROM conversations WHERE department_id=? AND status='open'").get(d.id).n });
export const listDepartments = ws => db.prepare('SELECT * FROM departments WHERE workspace_id=? ORDER BY position, name').all(ws);
/** Departments visitors may pick in the chat widget (when the workspace turned the picker on). */
export function widgetDepartments(ws) {
  if (!isEnabled(ws, 'departments') || !getWsSettings(ws).widgetDepartments) return [];
  return db.prepare('SELECT id, name FROM departments WHERE workspace_id=? AND public=1 ORDER BY position, name').all(ws);
}

async function saveDepartment(c, id) {
  const b = await c.body(), name = str(b.name, 60); if (!name) fail(400, 'Department name is required');
  if (b.color && !/^#[0-9a-fA-F]{6}$/.test(b.color)) fail(400, 'Color must be a hex value like #4f46e5');
  const clash = db.prepare('SELECT id FROM departments WHERE workspace_id=? AND lower(name)=lower(?)').get(c.ws, name);
  if (clash && clash.id !== id) fail(409, 'A department with that name already exists');
  const members = [...new Set((Array.isArray(b.members) ? b.members : []).map(toInt))];
  for (const uid of members) {
    const mem = memberOf(uid, c.ws);
    if (!mem) fail(400, 'Only workspace members can join a department');
    if (!memberPerms(mem).has('chats.reply')) fail(400, `${db.prepare('SELECT name FROM users WHERE id=?').get(uid).name}'s role can't reply to chats`);
  }
  const fields = [name, str(b.description, 200), b.color || '#6366f1', b.public === false ? 0 : 1, Math.max(0, Math.min(999, Math.round(Number(b.position)) || 0))];
  if (id) db.prepare('UPDATE departments SET name=?, description=?, color=?, public=?, position=? WHERE id=?').run(...fields, id);
  else {
    if (db.prepare('SELECT COUNT(*) n FROM departments WHERE workspace_id=?').get(c.ws).n >= 50) fail(400, 'A workspace can have up to 50 departments');
    id = Number(db.prepare('INSERT INTO departments(name,description,color,public,position,workspace_id,created) VALUES(?,?,?,?,?,?,?)').run(...fields, c.ws, now()).lastInsertRowid);
  }
  if (Array.isArray(b.members)) {
    db.prepare('DELETE FROM department_members WHERE department_id=?').run(id);
    for (const uid of members) db.prepare('INSERT INTO department_members(department_id,user_id) VALUES(?,?)').run(id, uid);
  }
  c.log(c.params.id ? 'department.updated' : 'department.created', `${name} (${members.length} members)`);
  drainQueue(c.ws);
  return { department: deptOut(db.prepare('SELECT * FROM departments WHERE id=?').get(id)) };
}
const ownDept = c => db.prepare('SELECT * FROM departments WHERE id=? AND workspace_id=?').get(c.int('id'), c.ws) || fail(404, 'Department not found');

export default defineModule({
  key: 'departments', name: 'Departments & routing', description: 'Teams like Sales and Support, automatic chat assignment (round robin or least busy), queues and agent availability.',
  init() {
    routing.assign = routeConversation;
    on('agent.online', ({ ws }) => drainQueue(ws));
    on('agent.status', ({ status, workspaces }) => { if (status === 'available') for (const ws of workspaces) drainQueue(ws); });
    on('conversation.closed', ({ conv }) => drainQueue(conv.workspace_id));
    on('conversation.unsnoozed', ({ conv }) => routeConversation(conv));
  },
  routes: [
    { method: 'GET', path: '/api/departments', auth: 'ws', handler: c => ({ departments: listDepartments(c.ws).map(deptOut), routing: getWsSettings(c.ws), modes: MODES }) },
    { method: 'POST', path: '/api/departments', auth: 'ws', perm: 'team.manage', handler: c => saveDepartment(c, null) },
    { method: 'PUT', path: '/api/departments/:id', auth: 'ws', perm: 'team.manage', handler: c => saveDepartment(c, ownDept(c).id) },
    { method: 'DELETE', path: '/api/departments/:id', auth: 'ws', perm: 'team.manage', handler: c => {
      const d = ownDept(c);
      db.prepare('DELETE FROM departments WHERE id=?').run(d.id); c.log('department.deleted', d.name); return {};
    } },
    { method: 'PUT', path: '/api/routing', auth: 'ws', perm: 'team.manage', handler: async c => {
      const b = await c.body(), patch = {};
      if ('assignmentMode' in b) { if (!MODES.includes(b.assignmentMode)) fail(400, 'Mode must be manual, round_robin or least_busy'); patch.assignmentMode = b.assignmentMode; }
      if ('maxChats' in b) patch.maxChats = Math.max(0, Math.min(50, Math.round(Number(b.maxChats)) || 0));
      if ('widgetDepartments' in b) patch.widgetDepartments = !!b.widgetDepartments;
      setWsSettings(c.ws, patch); c.log('routing.updated', Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', '));
      const routed = drainQueue(c.ws);
      return { routing: getWsSettings(c.ws), routed };
    } },
  ],
});
