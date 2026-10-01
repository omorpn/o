/**
 * Tickets domain: numbering, SLA targets, the message thread, the change history and realtime fan-out.
 * Used by the tickets API, by "create ticket from chat" and by inbound channels (email).
 */
import { db, now, getWsSettings, registerWsDefaults } from '../../core/db.js';
import { fail, str } from '../../core/http.js';
import { emit } from '../../core/events.js';
import { agentStreams, frame, put } from '../../core/realtime.js';

db.exec(`
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, number INTEGER NOT NULL,
  subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'normal',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL, department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL, conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  visitor_id TEXT, requester_name TEXT, requester_email TEXT, channel TEXT NOT NULL DEFAULT 'manual', tags TEXT, custom TEXT,
  first_response_due INTEGER, due_at INTEGER, first_response_at INTEGER, solved_at INTEGER, closed_at INTEGER, sla_notified TEXT,
  merged_into INTEGER, created_by INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL, UNIQUE(workspace_id, number));
CREATE INDEX IF NOT EXISTS idx_tickets_ws ON tickets(workspace_id, status, updated);
CREATE INDEX IF NOT EXISTS idx_tickets_email ON tickets(workspace_id, requester_email);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  author_type TEXT NOT NULL, author_id INTEGER, author_name TEXT, author_email TEXT, body TEXT NOT NULL, attachments TEXT,
  email_message_id TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tmsg_ticket ON ticket_messages(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_tmsg_email ON ticket_messages(email_message_id) WHERE email_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, user_id INTEGER, user_name TEXT,
  action TEXT NOT NULL, detail TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tevt_ticket ON ticket_events(ticket_id, id);
`);

export const STATUSES = ['open', 'pending', 'solved', 'closed'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const FIELD_TYPES = ['text', 'number', 'select', 'checkbox'];
/** Hours to first response / to resolution, by priority. */
export const SLA_DEFAULTS = { urgent: [1, 4], high: [4, 24], normal: [8, 72], low: [24, 168] };
registerWsDefaults({ ticketSla: SLA_DEFAULTS, ticketAutoCloseDays: 4, ticketFields: [] });

export const getTicket = id => db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
const nameOf = id => (id ? db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name : null) || null;

/** SLA deadlines measured from creation, for the ticket's priority. */
export function slaFor(ws, priority, created) {
  const [first, resolve] = (getWsSettings(ws).ticketSla || SLA_DEFAULTS)[priority] || SLA_DEFAULTS.normal;
  return { first_response_due: first ? created + first * 3600_000 : null, due_at: resolve ? created + resolve * 3600_000 : null };
}
/** "ok" | "due_soon" | "breached" | null (no target / not running). */
export function slaState(t, at = now()) {
  if (['solved', 'closed'].includes(t.status)) return null;
  const due = !t.first_response_at && t.first_response_due ? Math.min(t.first_response_due, t.due_at || Infinity) : t.due_at;
  if (!due) return null;
  return due < at ? 'breached' : due - at < 3600_000 ? 'due_soon' : 'ok';
}

export function ticketOut(t, { full = false } = {}) {
  const dep = t.department_id ? db.prepare('SELECT name, color FROM departments WHERE id=?').get(t.department_id) : null;
  const out = { id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority, assignee_id: t.assignee_id, assignee_name: nameOf(t.assignee_id),
    department_id: dep ? t.department_id : null, department_name: dep?.name || null, department_color: dep?.color || null, site_id: t.site_id, conversation_id: t.conversation_id,
    requester_name: t.requester_name, requester_email: t.requester_email, channel: t.channel, tags: t.tags ? JSON.parse(t.tags) : [], custom: t.custom ? JSON.parse(t.custom) : {},
    first_response_due: t.first_response_due, due_at: t.due_at, first_response_at: t.first_response_at, solved_at: t.solved_at, closed_at: t.closed_at, merged_into: t.merged_into,
    sla: slaState(t), created: t.created, updated: t.updated,
    last_message: db.prepare("SELECT body, author_type FROM ticket_messages WHERE ticket_id=? AND kind!='system' ORDER BY id DESC LIMIT 1").get(t.id) || null };
  if (full) out.messages_count = db.prepare('SELECT COUNT(*) n FROM ticket_messages WHERE ticket_id=?').get(t.id).n;
  return out;
}
export const messageOut = m => ({ id: m.id, kind: m.kind, author_type: m.author_type, author_id: m.author_id, author_name: m.author_name, author_email: m.author_email,
  body: m.body, attachments: m.attachments ? JSON.parse(m.attachments) : [], created: m.created });

/** Can this live stream see this ticket? Mirrors canSee() below for realtime fan-out. */
const streamSees = (s, t) => s.ws === t.workspace_id && s.perms?.has('tickets.view') && (s.sites === null || !t.site_id || s.sites.has(t.site_id))
  && (s.perms.has('tickets.view_all') || !t.assignee_id || t.assignee_id === s.userId);
/** Pushes the ticket to every dashboard allowed to see it; tells the previous assignee to drop it when they lost access. */
export function broadcast(t, prevAssignee = null) {
  const f = frame('ticket', ticketOut(t)), gone = frame('ticket_deleted', { id: t.id });
  for (const s of agentStreams) {
    if (streamSees(s, t)) put(s.res, f);
    else if (prevAssignee && s.userId === prevAssignee && s.ws === t.workspace_id) put(s.res, gone);
  }
}
export function broadcastDeleted(t) { for (const s of agentStreams) if (s.ws === t.workspace_id) put(s.res, frame('ticket_deleted', { id: t.id })); }

export function logEvent(ticketId, user, action, detail) {
  db.prepare('INSERT INTO ticket_events(ticket_id,user_id,user_name,action,detail,created) VALUES(?,?,?,?,?,?)').run(ticketId, user?.id ?? null, user?.name ?? 'System', action, detail == null ? null : String(detail).slice(0, 500), now());
}

/** Validates custom field values against the workspace's field definitions. */
export function cleanCustom(ws, input, current = {}) {
  const defs = getWsSettings(ws).ticketFields || [], out = { ...current };
  for (const [k, v] of Object.entries(input || {})) {
    const d = defs.find(x => x.key === k); if (!d) continue;
    if (v === null || v === '') { delete out[k]; continue; }
    if (d.type === 'number') { const n = Number(v); if (!Number.isFinite(n)) fail(400, `${d.label} must be a number`); out[k] = n; }
    else if (d.type === 'checkbox') out[k] = !!v;
    else if (d.type === 'select') { if (!d.options.includes(String(v))) fail(400, `${d.label} must be one of: ${d.options.join(', ')}`); out[k] = String(v); }
    else out[k] = str(String(v), 500);
  }
  return out;
}
export const cleanTags = list => [...new Set((Array.isArray(list) ? list : []).map(t => str(String(t), 24).toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '')).filter(Boolean))].slice(0, 10);

/** Appends to the ticket thread. kind: public | note | system; author_type: agent | customer | system. */
export function addTicketMessage(t, { kind = 'public', authorType = 'agent', user = null, authorName = null, authorEmail = null, body, attachments = null, emailMessageId = null }) {
  const at = now();
  const id = db.prepare('INSERT INTO ticket_messages(ticket_id,kind,author_type,author_id,author_name,author_email,body,attachments,email_message_id,created) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(t.id, kind, authorType, user?.id ?? null, user?.name ?? authorName, authorEmail, body, attachments?.length ? JSON.stringify(attachments) : null, emailMessageId, at).lastInsertRowid;
  if (kind === 'public' && authorType === 'agent' && !t.first_response_at) db.prepare('UPDATE tickets SET first_response_at=? WHERE id=?').run(at, t.id);
  db.prepare('UPDATE tickets SET updated=? WHERE id=?').run(at, t.id);
  const m = messageOut(db.prepare('SELECT * FROM ticket_messages WHERE id=?').get(id)), fresh = getTicket(t.id);
  broadcast(fresh);
  for (const s of agentStreams) if (streamSees(s, fresh)) put(s.res, frame('ticket_message', { ticket_id: t.id, message: m }));
  emit('ticket.message', { ticket: fresh, message: m });
  return m;
}

/**
 * Creates a ticket. `body` becomes the first message (from the customer unless `authorType` says otherwise).
 * Returns the stored row.
 */
export function createTicket({ ws, subject, body, priority = 'normal', status = 'open', channel = 'manual', requesterName = null, requesterEmail = null, siteId = null,
  conversationId = null, visitorId = null, assigneeId = null, departmentId = null, tags = [], custom = {}, user = null, authorType = 'customer', emailMessageId = null, attachments = null }) {
  const at = now(), number = db.prepare('SELECT COALESCE(MAX(number),0)+1 n FROM tickets WHERE workspace_id=?').get(ws).n;
  const sla = slaFor(ws, priority, at);
  const id = db.prepare(`INSERT INTO tickets(workspace_id,number,subject,status,priority,assignee_id,department_id,site_id,conversation_id,visitor_id,requester_name,requester_email,channel,tags,custom,
      first_response_due,due_at,created_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ws, number, subject, status, priority, assigneeId, departmentId, siteId, conversationId, visitorId, requesterName, requesterEmail, channel,
      tags.length ? JSON.stringify(tags) : null, Object.keys(custom).length ? JSON.stringify(custom) : null, sla.first_response_due, sla.due_at, user?.id ?? null, at, at).lastInsertRowid;
  const t = getTicket(id);
  logEvent(t.id, user, 'created', `via ${channel}`);
  if (body) addTicketMessage(t, { kind: 'public', authorType, user: authorType === 'agent' ? user : null, authorName: authorType === 'customer' ? requesterName || requesterEmail : null, authorEmail: authorType === 'customer' ? requesterEmail : null, body, emailMessageId, attachments });
  const fresh = getTicket(id);
  broadcast(fresh);
  emit('ticket.created', { ticket: fresh, by: user });
  if (assigneeId && assigneeId !== user?.id) emit('ticket.assigned', { ticket: fresh, assigneeId, by: user });
  return fresh;
}

const LABEL = { status: 'Status', priority: 'Priority', assignee_id: 'Assignee', department_id: 'Department', subject: 'Subject', tags: 'Tags', custom: 'Fields' };
const show = (k, v) => (v == null || v === '' ? '—' : k === 'assignee_id' ? nameOf(v) || '—' : k === 'department_id' ? db.prepare('SELECT name FROM departments WHERE id=?').get(v)?.name || '—' : Array.isArray(v) ? v.join(', ') || '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Applies validated property changes, records them in the history and announces them. Returns the fresh row. */
export function updateTicket(t, patch, user) {
  const at = now(), set = {}, changes = [];
  for (const [k, v] of Object.entries(patch)) {
    const cur = k === 'tags' ? (t.tags ? JSON.parse(t.tags) : []) : k === 'custom' ? (t.custom ? JSON.parse(t.custom) : {}) : t[k];
    if (JSON.stringify(cur ?? null) === JSON.stringify(v ?? null)) continue;
    set[k] = k === 'tags' ? (v.length ? JSON.stringify(v) : null) : k === 'custom' ? (Object.keys(v).length ? JSON.stringify(v) : null) : v;
    changes.push([k, cur, v]);
  }
  if (!changes.length) return t;
  if ('status' in set) {
    if (set.status === 'solved') set.solved_at = at; else if (set.status === 'closed') set.closed_at = at;
    if (['open', 'pending'].includes(set.status)) { set.solved_at = null; set.closed_at = null; }
  }
  if ('priority' in set) Object.assign(set, slaFor(t.workspace_id, set.priority, t.created), { sla_notified: null });
  set.updated = at;
  db.prepare(`UPDATE tickets SET ${Object.keys(set).map(k => k + '=?').join(', ')} WHERE id=?`).run(...Object.values(set), t.id);
  const defs = getWsSettings(t.workspace_id).ticketFields || [];
  for (const [k, from, to] of changes) {
    if (k !== 'custom') { logEvent(t.id, user, 'changed', `${LABEL[k] || k}: ${show(k, from)} → ${show(k, to)}`); continue; }
    for (const f of new Set([...Object.keys(from || {}), ...Object.keys(to || {})])) if (JSON.stringify(from?.[f]) !== JSON.stringify(to?.[f]))
      logEvent(t.id, user, 'changed', `${defs.find(d => d.key === f)?.label || f}: ${show(f, from?.[f])} → ${show(f, to?.[f])}`);
  }
  const fresh = getTicket(t.id);
  broadcast(fresh, 'assignee_id' in set ? t.assignee_id : null);
  emit('ticket.updated', { ticket: fresh, changes: Object.fromEntries(changes.map(([k, from, to]) => [k, { from, to }])), by: user });
  if ('assignee_id' in set && set.assignee_id && set.assignee_id !== user?.id) emit('ticket.assigned', { ticket: fresh, assigneeId: set.assignee_id, by: user });
  if (set.status === 'solved') emit('ticket.solved', { ticket: fresh, by: user });
  return fresh;
}

/** Closes tickets that stayed solved longer than the workspace allows. Returns how many closed. */
export function autoClose() {
  let n = 0;
  for (const t of db.prepare("SELECT * FROM tickets WHERE status='solved' AND solved_at IS NOT NULL").all()) {
    const days = getWsSettings(t.workspace_id).ticketAutoCloseDays; if (!days) continue;
    if (now() - t.solved_at < days * 86400_000) continue;
    updateTicket(t, { status: 'closed' }, null); n++;
  }
  return n;
}
