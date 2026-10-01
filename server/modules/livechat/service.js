/** Live chat domain: visitors, conversations, messages, presence. Publishes events other modules react to. */
import { writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { db, now, getSettings } from '../../core/db.js';
import { str, fail, ipOf } from '../../core/http.js';
import { emit } from '../../core/events.js';
import { toAgents, toVisitor, agentsOnline, isOnline } from '../../core/realtime.js';

export const UPLOAD_DIR = path.join(path.dirname(process.env.DB_FILE && process.env.DB_FILE !== ':memory:' ? process.env.DB_FILE : path.join(process.cwd(), 'data', 'x')), 'uploads');
await mkdir(UPLOAD_DIR, { recursive: true });
export const UPLOAD_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt' };

export const siteRow = id => db.prepare('SELECT * FROM sites WHERE id=?').get(id);
export const siteWs = id => siteRow(id)?.workspace_id;
export const getConv = id => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
export const getVisitor = id => db.prepare('SELECT * FROM visitors WHERE id=?').get(id);

export function withinHours(siteId) {
  const s = getSettings(siteId); if (!s.businessHoursEnabled) return true;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: s.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(p => [p.type, p.value]));
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    return s.hoursDays.split(',').map(Number).includes(day) && `${parts.hour}:${parts.minute}` >= s.hoursStart && `${parts.hour}:${parts.minute}` < s.hoursEnd;
  } catch { return true; }
}
export const teamAvailable = siteId => agentsOnline(siteId) > 0 && withinHours(siteId);

export const visitorOut = v => v && ({ id: v.id, site_id: v.site_id, name: v.name, email: v.email, phone: v.phone || null, channel: v.channel || 'web', page: v.page, ua: v.ua, visits: v.visits, created: v.created, last_seen: v.last_seen, online: isOnline(v.id) });
export function convOut(c) {
  const v = getVisitor(c.visitor_id);
  const a = c.assignee_id ? db.prepare('SELECT name FROM users WHERE id=?').get(c.assignee_id) : null;
  const d = c.department_id ? db.prepare('SELECT name, color FROM departments WHERE id=?').get(c.department_id) : null;
  return { id: c.id, site_id: c.site_id, site_name: siteRow(c.site_id)?.name, status: c.status, assignee_id: c.assignee_id, assignee_name: a?.name || null, bot_active: !!c.bot_active,
    channel: c.channel || 'web', last_inbound: c.last_inbound || null, department_id: d ? c.department_id : null, department_name: d?.name || null, department_color: d?.color || null, priority: c.priority || 'normal', snoozed_until: c.snoozed_until || null,
    needs_human: !!c.needs_human, spam: !!c.spam, spam_score: c.spam_score || 0, tags: c.tags ? JSON.parse(c.tags) : [], unread: c.unread, last_body: c.last_body, created: c.created, updated: c.updated, visitor: visitorOut(v) };
}
export const msgOut = m => ({ id: m.id, conv_id: m.conv_id, sender: m.sender, sender_name: m.sender_name, body: m.body, buttons: m.buttons ? JSON.parse(m.buttons) : [], attachment: m.attachment ? JSON.parse(m.attachment) : null, delivery: m.delivery || null, created: m.created });
export const emitConv = (c, event = 'conversation') => toAgents(c.workspace_id, c.site_id, event, convOut(c), c);
export const emitPresence = (v, online) => toAgents(siteWs(v.site_id), v.site_id, 'presence', { visitor_id: v.id, online, visitor: visitorOut(v) });

/** Stores a message, pushes it to agents/visitor in realtime and publishes `message.created`. */
export function addMessage(conv, sender, body, { senderId = null, senderName = null, buttons = null, attachment = null } = {}) {
  const t = now();
  const info = db.prepare('INSERT INTO messages(conv_id,sender,sender_id,sender_name,body,buttons,attachment,created) VALUES(?,?,?,?,?,?,?,?)')
    .run(conv.id, sender, senderId, senderName, body, buttons?.length ? JSON.stringify(buttons) : null, attachment ? JSON.stringify(attachment) : null, t);
  if (sender !== 'note') {
    db.prepare('UPDATE conversations SET last_body=CASE WHEN ? THEN last_body ELSE ? END, updated=?, unread=unread+? WHERE id=?').run(sender === 'system' ? 1 : 0, body.slice(0, 140), t, sender === 'visitor' ? 1 : 0, conv.id);
  }
  const m = msgOut(db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid));
  const fresh = getConv(conv.id);
  toAgents(fresh.workspace_id, fresh.site_id, 'message', { conv: convOut(fresh), message: m }, fresh);
  if (sender !== 'note') toVisitor(conv.visitor_id, 'message', m);
  emit('message.created', { conv: fresh, message: m, senderId });
  return m;
}

/**
 * Automatic assignment hook. The departments module installs `assign(conv)`; live chat calls it when a conversation
 * starts without the bot or is handed over to the team, before announcing it, so notifications know the assignee.
 */
export const routing = { assign: null };
const route = id => { try { routing.assign?.(getConv(id)); } catch (e) { console.error('routing failed:', e); } return getConv(id); };
/** A department id that belongs to the workspace, or null. */
export const validDepartment = (ws, id) => (id && db.prepare('SELECT id FROM departments WHERE id=? AND workspace_id=?').get(Number(id), ws)?.id) || null;

export function openConversation(site, vkey, { botEnabled = true, departmentId = null, channel = 'web' } = {}) {
  let c = db.prepare("SELECT * FROM conversations WHERE visitor_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(vkey);
  if (c) return c;
  const t = now();
  const id = db.prepare('INSERT INTO conversations(site_id,workspace_id,visitor_id,status,bot_active,department_id,channel,created,updated) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(site.id, site.workspace_id, vkey, 'open', botEnabled && getSettings(site.id).botEnabled ? 1 : 0, validDepartment(site.workspace_id, departmentId), channel, t, t).lastInsertRowid;
  c = getConv(id);
  if (!c.bot_active) c = route(id);
  emitConv(c);
  emit('conversation.created', { conv: c });
  return c;
}

export function upsertVisitor(site, vkey, page, req) {
  const t = now(); const ua = str(req.headers['user-agent'], 300), ip = ipOf(req);
  const ex = getVisitor(vkey);
  if (!ex) db.prepare('INSERT INTO visitors(id,site_id,created,last_seen,page,ua,ip) VALUES(?,?,?,?,?,?,?)').run(vkey, site.id, t, t, page, ua, ip);
  else db.prepare('UPDATE visitors SET last_seen=?, page=COALESCE(NULLIF(?,\'\'),page), ua=?, ip=?, visits=visits+? WHERE id=?')
    .run(t, page, ua, ip, t - ex.last_seen > 30 * 60_000 ? 1 : 0, vkey);
  return getVisitor(vkey);
}

export async function saveUpload(b) {
  const type = str(b.type, 100), ext = UPLOAD_TYPES[type];
  if (!ext) fail(400, 'Unsupported file type (images, PDF and text only)');
  const buf = Buffer.from(String(b.data || ''), 'base64');
  if (!buf.length) fail(400, 'Empty file'); if (buf.length > 3_000_000) fail(413, 'File too large (max 3 MB)');
  const id = randomBytes(12).toString('hex') + '.' + ext;
  await writeFile(path.join(UPLOAD_DIR, id), buf);
  return { url: '/uploads/' + id, name: str(b.name, 100).replace(/[^\w.\- ]/g, '_') || 'file.' + ext, type };
}

export function transcriptText(convId) {
  const c = getConv(convId), v = getVisitor(c.visitor_id);
  return db.prepare("SELECT * FROM messages WHERE conv_id=? AND sender!='note' ORDER BY id").all(convId)
    .map(m => `[${new Date(m.created).toISOString()}] ${m.sender === 'visitor' ? (v.name || 'Visitor') : m.sender_name || m.sender}: ${m.body}`).join('\n');
}

export const setFlowState = (id, st) => db.prepare('UPDATE conversations SET flow_state=? WHERE id=?').run(st ? JSON.stringify(st) : null, id);

/** Hands the conversation from the bot to the team and tells the visitor whether someone is online. */
export function handoff(conv, { departmentId = null } = {}) {
  setFlowState(conv.id, null);
  const s = getSettings(conv.site_id), online = teamAvailable(conv.site_id);
  db.prepare('UPDATE conversations SET bot_active=0, needs_human=1, snoozed_until=NULL, department_id=COALESCE(?,department_id) WHERE id=?').run(validDepartment(conv.workspace_id, departmentId), conv.id);
  route(conv.id);
  addMessage(getConv(conv.id), 'bot', online ? s.handoffMessage : s.offlineMessage, { senderName: 'Bot' });
  toVisitor(conv.visitor_id, 'handoff', { online, hasEmail: !!getVisitor(conv.visitor_id)?.email });
  const fresh = getConv(conv.id);
  emitConv(fresh);
  emit('conversation.handoff', { conv: fresh, teamOnline: online });
}

/** Saves visitor details captured by the widget or a flow and tells everyone. */
export function identifyVisitor(vkey, { name = '', email = '' }) {
  db.prepare('UPDATE visitors SET name=COALESCE(NULLIF(?,\'\'),name), email=COALESCE(NULLIF(?,\'\'),email) WHERE id=?').run(name, email, vkey);
  const v = getVisitor(vkey);
  emitPresence(v, isOnline(vkey));
  if (email) emit('visitor.identified', { visitor: v });
  return v;
}
