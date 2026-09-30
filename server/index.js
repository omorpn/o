import http from 'node:http';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, seed, getSettings, setSettings, hashPassword, checkPassword, createSite, createWorkspace, newSiteKey, getPlatform, setPlatform } from './db.js';
import { PERMISSIONS, ALL as ALL_PERMS, cleanPerms } from './rbac.js';
import * as fraud from './fraud.js';
import { matchRule, parseRule, matchKb, aiAnswer, matchFlow, validateNodes, HUMAN_PHRASE } from './bot.js';
import { sendMail, mailConfigured } from './mail.js';

seed();
const UPLOAD_DIR = path.join(path.dirname(process.env.DB_FILE && process.env.DB_FILE !== ':memory:' ? process.env.DB_FILE : path.join(process.cwd(), 'data', 'x')), 'uploads');
await mkdir(UPLOAD_DIR, { recursive: true });
const UPLOAD_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt' };
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

// ---------- helpers ----------
const send = (res, code, obj) => {
  const body = JSON.stringify(obj ?? {});
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

async function readBody(req, max = 200_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) fail(413, 'Payload too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'Invalid JSON'); }
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const hits = new Map();
function limit(key, max, windowMs) {
  const t = now(); const arr = (hits.get(key) || []).filter(x => t - x < windowMs);
  if (arr.length >= max) fail(429, 'Too many requests, slow down');
  arr.push(t); hits.set(key, arr);
}
setInterval(() => { const t = now(); for (const [k, v] of hits) if (!v.some(x => t - x < 120_000)) hits.delete(k); }, 60_000).unref();
// TRUST_PROXY = number of proxy hops in front of the app (Cloud Run: 1, Firebase Hosting → Cloud Run: 2)
const HOPS = Number(process.env.TRUST_PROXY) || 0;
const ipOf = req => {
  if (HOPS) { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean); if (x.length >= HOPS) return x[x.length - HOPS]; }
  return req.socket.remoteAddress || '';
};
const secureReq = req => req.socket.encrypted || (HOPS && /https/i.test(String(req.headers['x-forwarded-proto'] || '')));

// ---------- realtime hub ----------
// Agent streams carry the viewer's scope so every event is filtered by workspace, site access and permissions.
const agentStreams = new Set();           // { res, userId, ws, sites: Set|null, viewAll, canReply }
const visitorStreams = new Map();         // visitor key "<siteId>:<vid>" -> Set(res)
const offlineTimers = new Map();

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
}
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const streamSees = (s, siteId, conv) => (s.sites === null || s.sites.has(siteId)) && (!conv || s.viewAll || !conv.assignee_id || conv.assignee_id === s.userId);
function toAgents(ws, siteId, event, data, conv) {
  const f = frame(event, data);
  for (const s of agentStreams) if (s.ws === ws && (siteId == null || streamSees(s, siteId, conv))) s.res.write(f);
}
const toVisitor = (vkey, event, data) => { const f = frame(event, data); for (const r of visitorStreams.get(vkey) || []) r.write(f); };
function toSiteVisitors(siteId, event, data) {
  const f = frame(event, data), prefix = siteId + ':';
  for (const [k, set] of visitorStreams) if (k.startsWith(prefix)) for (const r of set) r.write(f);
}
setInterval(() => {
  for (const s of agentStreams) s.res.write(': ping\n\n');
  for (const set of visitorStreams.values()) for (const r of set) r.write(': ping\n\n');
}, 25_000).unref();
const agentsOnline = siteId => new Set([...agentStreams].filter(s => s.canReply && s.ws === siteWs(siteId) && (s.sites === null || s.sites.has(siteId))).map(s => s.userId)).size;
const isOnline = vkey => (visitorStreams.get(vkey)?.size || 0) > 0;
/** Ends a user's live connections in a workspace so they reconnect with fresh permissions. */
function kickUser(userId, ws) { for (const s of agentStreams) if (s.userId === userId && (ws == null || s.ws === ws)) s.res.end(); }
function kickWorkspace(ws) {
  for (const s of agentStreams) if (s.ws === ws) s.res.end();
  const ids = new Set(db.prepare('SELECT id FROM sites WHERE workspace_id=?').all(ws).map(r => String(r.id)));
  for (const [k, set] of visitorStreams) if (ids.has(k.split(':')[0])) for (const r of set) r.end();
}

// ---------- sites, webhooks & business hours ----------
const siteRow = id => db.prepare('SELECT * FROM sites WHERE id=?').get(id);
const siteWs = id => siteRow(id)?.workspace_id;
function webhook(siteId, event, data) {
  const url = getSettings(siteId).webhookUrl; if (!/^https?:\/\//.test(url)) return;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, site_id: siteId, time: now(), data }), signal: AbortSignal.timeout(8000) }).catch(() => {});
}
function withinHours(siteId) {
  const s = getSettings(siteId); if (!s.businessHoursEnabled) return true;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: s.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(p => [p.type, p.value]));
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    return s.hoursDays.split(',').map(Number).includes(day) && `${parts.hour}:${parts.minute}` >= s.hoursStart && `${parts.hour}:${parts.minute}` < s.hoursEnd;
  } catch { return true; }
}
const teamAvailable = siteId => agentsOnline(siteId) > 0 && withinHours(siteId);
function audit(ws, user, action, detail) {
  db.prepare('INSERT INTO audit(workspace_id,user_id,user_name,action,detail,created) VALUES(?,?,?,?,?,?)').run(ws, user?.id ?? null, user?.name ?? 'system', action, detail ? String(detail).slice(0, 500) : null, now());
}

// ---------- domain ----------
const visitorOut = v => v && ({ id: v.id, site_id: v.site_id, name: v.name, email: v.email, page: v.page, ua: v.ua, visits: v.visits, created: v.created, last_seen: v.last_seen, online: isOnline(v.id) });
function convOut(c) {
  const v = db.prepare('SELECT * FROM visitors WHERE id=?').get(c.visitor_id);
  const a = c.assignee_id ? db.prepare('SELECT name FROM users WHERE id=?').get(c.assignee_id) : null;
  return { id: c.id, site_id: c.site_id, site_name: siteRow(c.site_id)?.name, status: c.status, assignee_id: c.assignee_id, assignee_name: a?.name || null, bot_active: !!c.bot_active,
    needs_human: !!c.needs_human, spam: !!c.spam, spam_score: c.spam_score || 0, tags: c.tags ? JSON.parse(c.tags) : [], unread: c.unread, last_body: c.last_body, created: c.created, updated: c.updated, visitor: visitorOut(v) };
}
const msgOut = m => ({ id: m.id, conv_id: m.conv_id, sender: m.sender, sender_name: m.sender_name, body: m.body, buttons: m.buttons ? JSON.parse(m.buttons) : [], attachment: m.attachment ? JSON.parse(m.attachment) : null, created: m.created });
const getConv = id => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
const emitConv = (c, event = 'conversation') => toAgents(c.workspace_id, c.site_id, event, convOut(c), c);
const emitPresence = (v, online) => toAgents(siteWs(v.site_id), v.site_id, 'presence', { visitor_id: v.id, online, visitor: visitorOut(v) });

function addMessage(conv, sender, body, { senderId = null, senderName = null, buttons = null, attachment = null } = {}) {
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
  return m;
}

function openConversation(site, vkey) {
  let c = db.prepare("SELECT * FROM conversations WHERE visitor_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(vkey);
  if (c) return c;
  const t = now();
  const id = db.prepare('INSERT INTO conversations(site_id,workspace_id,visitor_id,status,bot_active,created,updated) VALUES(?,?,?,?,?,?,?)')
    .run(site.id, site.workspace_id, vkey, 'open', getSettings(site.id).botEnabled ? 1 : 0, t, t).lastInsertRowid;
  c = getConv(id);
  emitConv(c);
  webhook(site.id, 'conversation.created', convOut(c));
  return c;
}

// ---------- email ----------
const logMailErr = e => console.error('mail error:', e.message);
/** Members who can reply on a site. */
function siteResponders(siteId) {
  const ws = siteWs(siteId);
  return db.prepare('SELECT u.id, u.name, u.email, m.site_ids, r.permissions FROM members m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.workspace_id=?').all(ws)
    .filter(r => JSON.parse(r.permissions).includes('chats.reply') && (!r.site_ids || JSON.parse(r.site_ids).includes(siteId)));
}
function maybeNotify(convId) {
  const c = getConv(convId); if (!c) return;
  const s = getSettings(c.site_id); if (!mailConfigured() || !s.emailNotifications || agentsOnline(c.site_id) > 0) return;
  if (c.last_notified && now() - c.last_notified < 10 * 60_000) return;
  db.prepare('UPDATE conversations SET last_notified=? WHERE id=?').run(now(), convId);
  const v = db.prepare('SELECT * FROM visitors WHERE id=?').get(c.visitor_id);
  const last = db.prepare("SELECT body FROM messages WHERE conv_id=? AND sender='visitor' ORDER BY id DESC LIMIT 1").get(convId)?.body || '';
  const subject = `[${siteRow(c.site_id).name}] New message from ${v.name || v.email || 'a visitor'}`;
  const text = `${last}\n\nReply in your dashboard: conversation #${convId}${v.email ? `\nVisitor email: ${v.email}` : ''}`;
  for (const a of siteResponders(c.site_id)) sendMail({ to: a.email, subject, text }).catch(logMailErr);
}
function emailVisitor(convId, subject, text) {
  if (!mailConfigured()) return;
  const v = db.prepare('SELECT v.email FROM visitors v JOIN conversations c ON c.visitor_id=v.id WHERE c.id=?').get(convId);
  if (v?.email) sendMail({ to: v.email, subject, text }).catch(logMailErr);
}
function transcriptText(convId) {
  const c = getConv(convId), v = db.prepare('SELECT * FROM visitors WHERE id=?').get(c.visitor_id);
  return db.prepare("SELECT * FROM messages WHERE conv_id=? AND sender!='note' ORDER BY id").all(convId)
    .map(m => `[${new Date(m.created).toISOString()}] ${m.sender === 'visitor' ? (v.name || 'Visitor') : m.sender_name || m.sender}: ${m.body}`).join('\n');
}

// ---------- flows & bot ----------
const setFlow = (id, st) => db.prepare('UPDATE conversations SET flow_state=? WHERE id=?').run(st ? JSON.stringify(st) : null, id);
function runFlow(convId, flow, nodeId) {
  for (let steps = 0; nodeId && steps < 25; steps++) {
    const n = flow.nodes.find(x => x.id === nodeId); if (!n || n.type === 'end') break;
    addMessage(getConv(convId), 'bot', n.text, { senderName: 'Bot', buttons: n.type === 'choice' ? n.options.map(o => o.label) : null });
    if (n.type === 'choice' || n.type === 'ask') return setFlow(convId, { flow: flow.id, node: n.id });
    if (n.type === 'handoff') { setFlow(convId, null); return handoff(getConv(convId)); }
    nodeId = n.next;
  }
  setFlow(convId, null);
}
/** Consumes the visitor's answer if a flow is waiting on one. Returns true when handled. */
function flowAnswer(conv, text) {
  const st = conv.flow_state ? JSON.parse(conv.flow_state) : null; if (!st) return false;
  const f = db.prepare('SELECT * FROM flows WHERE id=? AND site_id=?').get(st.flow, conv.site_id);
  const flow = f && { ...f, nodes: JSON.parse(f.nodes) }, n = flow?.nodes.find(x => x.id === st.node);
  if (!n) { setFlow(conv.id, null); return false; }
  if (n.type === 'choice') {
    const o = n.options.find(x => x.label.toLowerCase() === text.toLowerCase());
    if (!o) { setFlow(conv.id, null); return false; }
    runFlow(conv.id, flow, o.next); return true;
  }
  if (n.type === 'ask') {
    if (n.field === 'email') {
      const email = text.toLowerCase();
      if (!EMAIL.test(email)) { addMessage(getConv(conv.id), 'bot', "That doesn't look like a valid email — could you try again?", { senderName: 'Bot' }); return true; }
      db.prepare('UPDATE visitors SET email=? WHERE id=?').run(email, conv.visitor_id);
      addMessage(getConv(conv.id), 'system', `Visitor shared their email: ${email}`);
    } else if (n.field === 'name') db.prepare('UPDATE visitors SET name=? WHERE id=?').run(text.slice(0, 100), conv.visitor_id);
    else addMessage(getConv(conv.id), 'system', `${n.field === 'phone' ? 'Phone' : 'Answer'}: ${text}`);
    const v = db.prepare('SELECT * FROM visitors WHERE id=?').get(conv.visitor_id);
    emitPresence(v, isOnline(v.id));
    if (n.field === 'email') webhook(conv.site_id, 'visitor.identified', visitorOut(v));
    runFlow(conv.id, flow, n.next); return true;
  }
  setFlow(conv.id, null); return false;
}
function handoff(conv) {
  setFlow(conv.id, null);
  const s = getSettings(conv.site_id), online = teamAvailable(conv.site_id);
  db.prepare('UPDATE conversations SET bot_active=0, needs_human=1 WHERE id=?').run(conv.id);
  addMessage(getConv(conv.id), 'bot', online ? s.handoffMessage : s.offlineMessage, { senderName: 'Bot' });
  toVisitor(conv.visitor_id, 'handoff', { online, hasEmail: !!db.prepare('SELECT email FROM visitors WHERE id=?').get(conv.visitor_id)?.email });
  maybeNotify(conv.id);
  emitConv(getConv(conv.id));
}
function botRespond(convId, text) {
  const conv = getConv(convId);
  if (!conv || !conv.bot_active) return;
  const siteId = conv.site_id, s = getSettings(siteId);
  const reply = (body, buttons) => addMessage(getConv(convId), 'bot', body, { senderName: 'Bot', buttons });
  toVisitor(conv.visitor_id, 'typing', { who: 'bot' });
  setTimeout(async () => {
    try {
      const cur = getConv(convId);
      if (!cur || !cur.bot_active) return;
      if (text.toLowerCase() === HUMAN_PHRASE) return handoff(cur);
      if (flowAnswer(cur, text)) return;
      const flow = matchFlow(siteId, text);
      if (flow) return runFlow(convId, flow, flow.nodes[0].id);
      const rule = matchRule(siteId, text);
      if (rule) { reply(rule.reply, rule.buttons); if (rule.handoff) handoff(getConv(convId)); return; }
      const kb = matchKb(siteId, text);
      if (kb) return reply(kb.answer);
      if (s.aiEnabled) {
        const hist = db.prepare("SELECT sender, body FROM messages WHERE conv_id=? AND sender IN ('visitor','bot','agent') ORDER BY id DESC LIMIT 10").all(convId).reverse()
          .map(m => ({ role: m.sender === 'visitor' ? 'user' : 'assistant', body: m.body }));
        const msgs = []; for (const m of hist) { if (msgs.length && msgs.at(-1).role === m.role) msgs.at(-1).content += '\n' + m.body; else msgs.push({ role: m.role, content: m.body }); }
        while (msgs.length && msgs[0].role !== 'user') msgs.shift();
        const ans = await aiAnswer(siteId, msgs, s.aiInstructions);
        if (ans && getConv(convId)?.bot_active) return reply(ans);
      }
      if (getConv(convId)?.bot_active) reply(s.fallbackMessage, ['Talk to a human']);
    } catch (e) { console.error('bot error', e); }
  }, 700);
}

function upsertVisitor(site, vkey, page, req) {
  const t = now(); const ua = str(req.headers['user-agent'], 300), ip = ipOf(req);
  const ex = db.prepare('SELECT * FROM visitors WHERE id=?').get(vkey);
  if (!ex) db.prepare('INSERT INTO visitors(id,site_id,created,last_seen,page,ua,ip) VALUES(?,?,?,?,?,?,?)').run(vkey, site.id, t, t, page, ua, ip);
  else db.prepare('UPDATE visitors SET last_seen=?, page=COALESCE(NULLIF(?,\'\'),page), ua=?, ip=?, visits=visits+? WHERE id=?')
    .run(t, page, ua, ip, t - ex.last_seen > 30 * 60_000 ? 1 : 0, vkey);
  return db.prepare('SELECT * FROM visitors WHERE id=?').get(vkey);
}

async function saveUpload(b) {
  const type = str(b.type, 100), ext = UPLOAD_TYPES[type];
  if (!ext) fail(400, 'Unsupported file type (images, PDF and text only)');
  const buf = Buffer.from(String(b.data || ''), 'base64');
  if (!buf.length) fail(400, 'Empty file'); if (buf.length > 3_000_000) fail(413, 'File too large (max 3 MB)');
  const id = randomBytes(12).toString('hex') + '.' + ext;
  await writeFile(path.join(UPLOAD_DIR, id), buf);
  return { url: '/uploads/' + id, name: str(b.name, 100).replace(/[^\w.\- ]/g, '_') || 'file.' + ext, type };
}

// ---------- widget API (public) ----------
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Normalises what people type into "Allowed origins": scheme optional, trailing slash/path ignored, www. optional. */
const hostOf = v => String(v).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
function originAllowed(allowedList, origin) {
  if (allowedList.includes('*')) return true;
  if (!origin || origin === 'null') return false;
  const host = hostOf(origin);
  return allowedList.some(a => { const h = hostOf(a); return h === host || (h.startsWith('*.') && (host === h.slice(2) || host.endsWith(h.slice(1)))); });
}
function corsFor(req, res, siteId) {
  const allowed = siteId ? getSettings(siteId).allowedOrigins.split(',').map(s => s.trim()).filter(Boolean) : ['*'];
  const origin = req.headers.origin;
  const ok = originAllowed(allowed, origin);
  res.setHeader('Vary', 'Origin');
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') || !origin ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  return ok;
}
const VID = /^[A-Za-z0-9_-]{8,64}$/;
function siteByKey(key) {
  const site = (typeof key === 'string' && key.length < 80 && db.prepare('SELECT * FROM sites WHERE site_key=?').get(key)) || fail(403, 'Unknown site key — copy a fresh snippet from Settings → Websites (the key may have been rotated or the website deleted).');
  if (db.prepare('SELECT suspended FROM workspaces WHERE id=?').get(site.workspace_id)?.suspended) fail(403, 'This chat is currently unavailable (the workspace is suspended).');
  return site;
}
const publicSettings = (siteId, s) => ({ gradient: s.gradient, launcherStyle: s.launcherStyle, launcherLabel: s.launcherLabel, avatarUrl: s.avatarUrl, theme: s.theme, prechatForm: s.prechatForm, showBranding: s.showBranding,
  triggers: db.prepare('SELECT id,url_contains,delay,message,open_chat FROM triggers WHERE site_id=? AND enabled=1').all(siteId).map(t => ({ ...t, open_chat: !!t.open_chat })), ratingEnabled: s.ratingEnabled,
  title: s.title, subtitle: s.subtitle, color: s.color, position: s.position, greeting: s.greeting, askEmail: s.askEmail, proactiveEnabled: s.proactiveEnabled, proactiveDelay: s.proactiveDelay, proactiveMessage: s.proactiveMessage, brandName: s.brandName });

async function widgetRoute(req, res, url) {
  const route = url.pathname.slice('/api/widget/'.length);
  if (req.method === 'OPTIONS') { corsFor(req, res, null); res.writeHead(204); return res.end(); }
  res.setHeader('Access-Control-Allow-Origin', '*'); // lets the widget read error messages; corsFor narrows it for allowed requests
  let site, vid, b = {};
  if (route === 'events' && req.method === 'GET') { site = siteByKey(url.searchParams.get('key')); vid = url.searchParams.get('vid'); }
  else if (req.method === 'POST') { b = await readBody(req, route === 'upload' ? 4_500_000 : 200_000); site = siteByKey(b.key); vid = b.vid; }
  else fail(404, 'Not found');
  if (!corsFor(req, res, site.id)) {
    const o = String(req.headers.origin || 'unknown origin').slice(0, 200);
    db.prepare('UPDATE sites SET last_error=?, last_error_at=? WHERE id=?').run(`Blocked on ${o}: not in this website's Allowed origins`, now(), site.id);
    // still answer with CORS headers so the widget can show the reason in the browser console
    res.setHeader('Access-Control-Allow-Origin', '*');
    fail(403, `This website (${o}) is not in the Allowed origins for this Chatly site. Add it under Settings → Widget → Allowed origins.`);
  }
  if (!VID.test(vid || '')) fail(400, 'Invalid visitor id');
  const vkey = `${site.id}:${vid}`, ws = site.workspace_id;
  if (fraud.visitorBlocked(site, vkey, ipOf(req)) && route !== 'message') fail(403, 'This chat is currently unavailable.');

  if (route === 'events') {
    const v = upsertVisitor(site, vkey, '', req);
    sse(res);
    if (!visitorStreams.has(vkey)) visitorStreams.set(vkey, new Set());
    visitorStreams.get(vkey).add(res);
    clearTimeout(offlineTimers.get(vkey));
    emitPresence(v, true);
    res.write(frame('ready', { agentsOnline: teamAvailable(site.id) }));
    req.on('close', () => {
      const set = visitorStreams.get(vkey); set?.delete(res);
      if (set && !set.size) {
        visitorStreams.delete(vkey);
        offlineTimers.set(vkey, setTimeout(() => { offlineTimers.delete(vkey); toAgents(ws, site.id, 'presence', { visitor_id: vkey, online: false }); }, 4000));
      }
    });
    return;
  }
  // Per-visitor limit plus a generous per-IP ceiling: mobile carriers and offices put many visitors behind one IP.
  limit('wv:' + vkey, 120, 60_000);
  limit('w:' + ipOf(req), 3000, 60_000);

  if (route === 'init') {
    const v = upsertVisitor(site, vkey, str(b.page, 500), req);
    db.prepare('UPDATE sites SET last_seen_at=?, last_origin=? WHERE id=?').run(now(), str(req.headers.origin || '', 200) || str(b.page, 200).replace(/^(https?:\/\/[^/]+).*/, '$1') || null, site.id);
    const conv = db.prepare("SELECT * FROM conversations WHERE visitor_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(vkey);
    const messages = conv ? db.prepare('SELECT * FROM messages WHERE conv_id=? AND sender!=\'note\' ORDER BY id').all(conv.id).map(msgOut) : [];
    emitPresence(v, true);
    return send(res, 200, { settings: publicSettings(site.id, getSettings(site.id)), visitor: { name: v.name, email: v.email }, messages, agentsOnline: teamAvailable(site.id) });
  }
  if (route === 'ping') {
    const v = upsertVisitor(site, vkey, str(b.page, 500), req);
    emitPresence(v, isOnline(vkey));
    return send(res, 200, { ok: true });
  }
  if (route === 'message') {
    limit('wm:' + vkey, 30, 60_000);
    const body = str(b.body, 2000); if (!body) fail(400, 'Empty message');
    // Spam & abuse screening. Blocked messages are silently dropped so spammers don't learn what triggers the filter.
    const shadow = () => send(res, 200, { message: { id: -now(), conv_id: null, sender: 'visitor', sender_name: null, body, buttons: [], attachment: null, created: now() } });
    if (fraud.visitorBlocked(site, vkey, ipOf(req))) return shadow();
    const verdict = fraud.record({ kind: 'visitor_message', workspaceId: ws, siteId: site.id, visitorId: vkey, ip: ipOf(req), summary: body,
      signals: fraud.scoreVisitorMessage({ site, vkey, ip: ipOf(req), ua: req.headers['user-agent'], text: body, spamFilter: getSettings(site.id).spamFilter }) });
    if (verdict.blocked) {
      if (verdict.score >= 90) fraud.addBlock({ workspaceId: ws, type: 'visitor', value: vkey, reason: `Auto-blocked: spam score ${verdict.score}`, ttlMs: 24 * 3600_000 });
      return shadow();
    }
    const v = upsertVisitor(site, vkey, str(b.page, 500), req);
    const conv = openConversation(site, vkey);
    if (b.trigger && db.prepare('SELECT COUNT(*) n FROM messages WHERE conv_id=?').get(conv.id).n === 0) {
      const t = db.prepare('SELECT message FROM triggers WHERE id=? AND site_id=?').get(Number(b.trigger), site.id);
      if (t) addMessage(conv, 'bot', t.message, { senderName: 'Bot' });
    }
    if (verdict.score >= fraud.fraudSettings().reviewThreshold) db.prepare('UPDATE conversations SET spam_score=MAX(COALESCE(spam_score,0),?) WHERE id=?').run(verdict.score, conv.id);
    const m = addMessage(conv, 'visitor', body);
    webhook(site.id, 'message.created', { conversation_id: conv.id, sender: 'visitor', body, visitor: visitorOut(v) });
    botRespond(conv.id, body);
    if (!conv.bot_active) maybeNotify(conv.id);
    return send(res, 200, { message: m });
  }
  if (route === 'upload') {
    limit('wu:' + vkey, 10, 60_000);
    upsertVisitor(site, vkey, '', req);
    const att = await saveUpload(b); const conv = openConversation(site, vkey);
    return send(res, 200, { message: addMessage(conv, 'visitor', `📎 ${att.name}`, { attachment: att }) });
  }
  if (route === 'rate') {
    const rating = Math.round(Number(b.rating));
    if (!(rating >= 1 && rating <= 5)) fail(400, 'Rating must be 1-5');
    const c = db.prepare("SELECT * FROM conversations WHERE visitor_id=? AND status='closed' AND rating IS NULL ORDER BY id DESC LIMIT 1").get(vkey);
    if (!c) fail(404, 'Nothing to rate');
    db.prepare('UPDATE conversations SET rating=?, rating_comment=? WHERE id=?').run(rating, str(b.comment, 500), c.id);
    addMessage(getConv(c.id), 'system', `Visitor rated this conversation ${rating}/5${b.comment ? ': ' + str(b.comment, 500) : ''}`);
    webhook(site.id, 'conversation.rated', { conversation_id: c.id, rating });
    return send(res, 200, { ok: true });
  }
  if (route === 'typing') { toAgents(ws, site.id, 'typing', { visitor_id: vkey }); return send(res, 200, { ok: true }); }
  if (route === 'identify') {
    const name = str(b.name, 100), email = str(b.email, 200).toLowerCase();
    if (email && !EMAIL.test(email)) fail(400, 'Invalid email');
    upsertVisitor(site, vkey, '', req);
    db.prepare('UPDATE visitors SET name=COALESCE(NULLIF(?,\'\'),name), email=COALESCE(NULLIF(?,\'\'),email) WHERE id=?').run(name, email, vkey);
    const v = db.prepare('SELECT * FROM visitors WHERE id=?').get(vkey);
    const conv = db.prepare("SELECT * FROM conversations WHERE visitor_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(vkey);
    if (conv && email) addMessage(conv, 'system', `Visitor shared their email: ${email}`);
    if (email) webhook(site.id, 'visitor.identified', visitorOut(v));
    emitPresence(v, isOnline(vkey));
    return send(res, 200, { ok: true });
  }
  fail(404, 'Not found');
}

// ---------- auth & access control ----------
const setSession = (res, req, tok) => res.setHeader('Set-Cookie', `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secureReq(req) ? '; Secure' : ''}`);
function newSession(res, req, userId, ws) {
  const tok = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,workspace_id,created) VALUES(?,?,?,?)').run(tok, userId, ws, now());
  setSession(res, req, tok);
}
const memberOf = (userId, ws) => db.prepare('SELECT m.*, r.name role_name, r.system role_system, r.permissions FROM members m JOIN roles r ON r.id=m.role_id WHERE m.user_id=? AND m.workspace_id=?').get(userId, ws);
const firstWorkspace = userId => db.prepare('SELECT workspace_id FROM members WHERE user_id=? ORDER BY created LIMIT 1').get(userId)?.workspace_id ?? null;

/** Resolves the signed-in user, their current workspace, role, permissions and site access. */
function authCtx(req) {
  const tok = cookies(req).sid; if (!tok) return null;
  const sess = db.prepare('SELECT * FROM sessions WHERE token=?').get(tok); if (!sess) return null;
  if (now() - sess.created > 30 * 86400_000) { db.prepare('DELETE FROM sessions WHERE token=?').run(tok); return null; }
  const user = db.prepare('SELECT id, name, email, platform_role, disabled FROM users WHERE id=?').get(sess.user_id); if (!user || user.disabled) return null;
  let ws = sess.workspace_id, mem = ws && memberOf(user.id, ws);
  if (!mem) { ws = firstWorkspace(user.id); mem = ws && memberOf(user.id, ws); db.prepare('UPDATE sessions SET workspace_id=? WHERE token=?').run(ws, tok); }
  if (!mem) return { user, tok, ws: null, perms: new Set(), siteIds: [], role: null };
  const perms = new Set(mem.role_system ? ALL_PERMS : JSON.parse(mem.permissions));
  const all = db.prepare('SELECT id FROM sites WHERE workspace_id=? ORDER BY id').all(ws).map(r => r.id);
  const limited = mem.site_ids ? JSON.parse(mem.site_ids) : null;
  const w = db.prepare('SELECT suspended, suspended_reason FROM workspaces WHERE id=?').get(ws);
  return { user, tok, ws, perms, role: { id: mem.role_id, name: mem.role_name }, siteLimit: limited, siteIds: limited ? all.filter(id => limited.includes(id)) : all, suspended: w.suspended ? (w.suspended_reason || 'Suspended by the platform') : null };
}
const isSubset = (a, b) => [...a].every(p => b.has(p));
const rolePerms = roleId => { const r = db.prepare('SELECT permissions, system FROM roles WHERE id=?').get(roleId); return new Set(r?.system ? ALL_PERMS : JSON.parse(r?.permissions || '[]')); };
const ownerCount = ws => db.prepare("SELECT COUNT(*) n FROM members m JOIN roles r ON r.id=m.role_id WHERE m.workspace_id=? AND r.system=1").get(ws).n;
const roleOut = r => ({ id: r.id, name: r.name, system: !!r.system, permissions: r.system ? ALL_PERMS : JSON.parse(r.permissions), members: db.prepare('SELECT COUNT(*) n FROM members WHERE role_id=?').get(r.id).n });
const siteOut = s => ({ id: s.id, name: s.name, domain: s.domain, site_key: s.site_key, created: s.created, last_seen_at: s.last_seen_at, last_origin: s.last_origin, last_error: s.last_error_at > (s.last_seen_at || 0) ? s.last_error : null, last_error_at: s.last_error_at });
function cleanSiteIds(ws, list) {
  if (list == null) return null;
  if (!Array.isArray(list)) fail(400, 'site_ids must be a list');
  const valid = new Set(db.prepare('SELECT id FROM sites WHERE workspace_id=?').all(ws).map(r => r.id));
  const ids = [...new Set(list.map(Number))].filter(id => valid.has(id));
  if (!ids.length) fail(400, 'Pick at least one website, or give access to all');
  return ids;
}

async function apiRoute(req, res, url) {
  const p = url.pathname, m = req.method;
  let x;

  if (p === '/api/auth/login' && m === 'POST') {
    const b = await readBody(req), email = str(b.email, 200).toLowerCase(), ip = ipOf(req);
    const guard = fraud.loginGuard(email, ip);
    if (guard.locked) fail(429, `${guard.reason}. Try again${guard.retryInSec ? ` in ${Math.ceil(guard.retryInSec / 60)} min` : ' later'}.`);
    limit('login:' + ip, 10, 60_000);
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u || !checkPassword(String(b.password || ''), u.pass)) { fraud.loginFailed(email, ip); fail(401, 'Invalid email or password'); }
    fraud.loginSucceeded(u, ip);
    if (u.disabled) fail(403, 'This account has been disabled. Contact support.');
    db.prepare('UPDATE users SET last_login=? WHERE id=?').run(now(), u.id);
    newSession(res, req, u.id, firstWorkspace(u.id));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/auth/signup' && m === 'POST') {
    if (!getPlatform().allowSignup) fail(403, 'Sign-up is currently closed on this platform');
    limit('signup:' + ipOf(req), 5, 60 * 60_000);
    const b = await readBody(req);
    const name = str(b.name, 80), email = str(b.email, 200).toLowerCase(), pw = String(b.password || ''), wsName = str(b.workspace, 80) || `${name}'s workspace`;
    if (!name || !EMAIL.test(email)) fail(400, 'Your name and a valid email are required');
    if (pw.length < 8) fail(400, 'Password must be at least 8 characters');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail(409, 'An account with this email already exists — sign in instead');
    const ip = ipOf(req);
    const signals = fraud.scoreSignup({ email, name, workspace: wsName, ip, ua: req.headers['user-agent'], honeypot: b.company_website, elapsedMs: b.elapsed });
    const pre = signals.reduce((a, x) => a + x.weight, 0);
    if (pre >= fraud.fraudSettings().blockThreshold && fraud.fraudSettings().fraudMode === 'enforce') {
      fraud.record({ kind: 'signup', signals, ip, email, summary: `Sign-up blocked: ${name} / ${wsName}` });
      fail(403, "We couldn't create your account. If you think this is a mistake, contact support.");
    }
    const uid = Number(db.prepare('INSERT INTO users(name,email,pass,created,signup_ip,last_ip) VALUES(?,?,?,?,?,?)').run(name, email, hashPassword(pw), now(), ip, ip).lastInsertRowid);
    const { wsId } = createWorkspace(wsName, uid, str(b.site_name, 80) || 'My website', str(b.domain, 200) || null);
    fraud.record({ kind: 'signup', signals, workspaceId: wsId, userId: uid, ip, email, summary: `New workspace "${wsName}" by ${name}` });
    maybeAutoSuspend(wsId);
    audit(wsId, { id: uid, name }, 'workspace.created', wsName);
    newSession(res, req, uid, wsId);
    return send(res, 200, { ok: true });
  }
  const ctx = authCtx(req);
  if (p === '/api/auth/logout' && m === 'POST') {
    if (ctx) db.prepare('DELETE FROM sessions WHERE token=?').run(ctx.tok);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    return send(res, 200, {});
  }
  if (!ctx) fail(401, 'Not authenticated');
  const me = ctx.user, ws = ctx.ws;
  const can = perm => ctx.perms.has(perm);
  const need = (...perms) => { if (!perms.some(can)) fail(403, `You don't have permission to do this (${perms.join(' or ')})`); };
  const bodyId = v => { const n = Number(v); if (!Number.isInteger(n)) fail(400, 'Bad id'); return n; };
  const log = (action, detail) => audit(ws, me, action, detail);

  if (p === '/api/me' && m === 'GET') {
    const workspaces = db.prepare('SELECT w.id, w.name, r.name role FROM members m JOIN workspaces w ON w.id=m.workspace_id JOIN roles r ON r.id=m.role_id WHERE m.user_id=? ORDER BY w.name').all(me.id);
    return send(res, 200, { user: { id: me.id, name: me.name, email: me.email, platform_role: me.platform_role || null }, workspace: ws ? { ...db.prepare('SELECT id, name, plan FROM workspaces WHERE id=?').get(ws), suspended: ctx.suspended } : null, workspaces, announcement: getPlatform().announcement, role: ctx.role, permissions: [...ctx.perms],
      sites: ctx.siteIds.map(id => siteOut(siteRow(id))), catalog: PERMISSIONS, aiConfigured: !!process.env.ANTHROPIC_API_KEY, mailConfigured: mailConfigured(), signupEnabled: getPlatform().allowSignup });
  }
  if (p === '/api/me/password' && m === 'POST') {
    const b = await readBody(req); const u = db.prepare('SELECT * FROM users WHERE id=?').get(me.id);
    if (!checkPassword(String(b.current || ''), u.pass)) fail(403, 'Current password is wrong');
    if (String(b.password || '').length < 8) fail(400, 'Password must be at least 8 characters');
    db.prepare('UPDATE users SET pass=? WHERE id=?').run(hashPassword(b.password), me.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token!=?').run(me.id, ctx.tok);
    return send(res, 200, {});
  }
  if (p === '/api/me' && m === 'PUT') {
    const b = await readBody(req); const name = str(b.name, 80); if (!name) fail(400, 'Name is required');
    db.prepare('UPDATE users SET name=? WHERE id=?').run(name, me.id); return send(res, 200, {});
  }
  if (p === '/api/workspaces' && m === 'POST') {
    limit('ws:' + me.id, 10, 60 * 60_000);
    const b = await readBody(req); const name = str(b.name, 80); if (!name) fail(400, 'Workspace name is required');
    const { wsId } = createWorkspace(name, me.id, str(b.site_name, 80) || 'My website', str(b.domain, 200) || null);
    audit(wsId, me, 'workspace.created', name);
    db.prepare('UPDATE sessions SET workspace_id=? WHERE token=?').run(wsId, ctx.tok);
    return send(res, 200, { id: wsId });
  }
  if (p === '/api/workspaces/switch' && m === 'POST') {
    const b = await readBody(req); const id = bodyId(b.id);
    if (!memberOf(me.id, id)) fail(404, 'Workspace not found');
    db.prepare('UPDATE sessions SET workspace_id=? WHERE token=?').run(id, ctx.tok);
    return send(res, 200, {});
  }
  if (p.startsWith('/api/platform/')) return platformRoute(req, res, url, ctx);
  if (!ws) fail(403, 'You are not a member of any workspace. Create one to continue.');
  if (ctx.suspended) fail(403, `This workspace is suspended: ${ctx.suspended}. Contact support.`);

  if (p === '/api/workspace' && m === 'PUT') {
    need('workspace.manage'); const b = await readBody(req); const name = str(b.name, 80); if (!name) fail(400, 'Name is required');
    db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(name, ws); log('workspace.renamed', name); return send(res, 200, {});
  }

  // --- realtime ---
  if (p === '/api/events' && m === 'GET') {
    sse(res);
    const entry = { res, userId: me.id, ws, sites: ctx.siteLimit ? new Set(ctx.siteIds) : null, viewAll: can('chats.view_all'), canReply: can('chats.reply') };
    const before = new Map(ctx.siteIds.map(id => [id, teamAvailable(id)]));
    agentStreams.add(entry);
    res.write(frame('ready', {}));
    const announce = () => { for (const [id, was] of before) { const nowOn = teamAvailable(id); if (nowOn !== was) toSiteVisitors(id, 'agents', { online: nowOn }); } };
    announce();
    req.on('close', () => { for (const id of before.keys()) before.set(id, teamAvailable(id)); agentStreams.delete(entry); announce(); });
    return;
  }

  // --- sites ---
  const siteParam = () => {
    const id = Number(url.searchParams.get('site'));
    if (!ctx.siteIds.includes(id)) fail(404, 'Website not found');
    return id;
  };
  if (p === '/api/sites' && m === 'GET') return send(res, 200, { sites: ctx.siteIds.map(id => siteOut(siteRow(id))) });
  if (p === '/api/sites' && m === 'POST') {
    need('sites.manage'); const b = await readBody(req); const name = str(b.name, 80); if (!name) fail(400, 'Website name is required');
    const id = createSite(ws, name, str(b.domain, 200) || null); log('site.created', name);
    return send(res, 200, { site: siteOut(siteRow(id)) });
  }
  if ((x = p.match(/^\/api\/sites\/(\d+)(\/rotate-key)?$/))) {
    need('sites.manage'); const s = siteRow(+x[1]);
    if (!s || s.workspace_id !== ws || !ctx.siteIds.includes(s.id)) fail(404, 'Website not found');
    if (x[2] && m === 'POST') { db.prepare('UPDATE sites SET site_key=? WHERE id=?').run(newSiteKey(), s.id); log('site.key_rotated', s.name); return send(res, 200, { site: siteOut(siteRow(s.id)) }); }
    if (m === 'PUT') {
      const b = await readBody(req); const name = str(b.name, 80); if (!name) fail(400, 'Website name is required');
      db.prepare('UPDATE sites SET name=?, domain=? WHERE id=?').run(name, str(b.domain, 200) || null, s.id); log('site.updated', name); return send(res, 200, {});
    }
    if (m === 'DELETE') {
      if (db.prepare('SELECT COUNT(*) n FROM sites WHERE workspace_id=?').get(ws).n <= 1) fail(400, "You can't delete the only website in a workspace");
      db.prepare('DELETE FROM sites WHERE id=?').run(s.id); log('site.deleted', s.name); return send(res, 200, {});
    }
  }

  // --- stats ---
  const scopeSites = () => { const q = url.searchParams.get('site'); if (q) return [siteParam()]; return ctx.siteIds; };
  const inSites = ids => `(${ids.map(Number).join(',') || 'NULL'})`;
  if (p === '/api/stats' && m === 'GET') {
    need('chats.view'); const ids = scopeSites(), S = inSites(ids);
    const one = (q, ...a) => db.prepare(q).get(...a).n;
    const day = new Date(); day.setHours(0, 0, 0, 0);
    let visitorsOnline = 0; for (const k of visitorStreams.keys()) if (ids.includes(Number(k.split(':')[0]))) visitorsOnline++;
    return send(res, 200, {
      open: one(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND status='open'`),
      unassigned: one(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND status='open' AND assignee_id IS NULL`),
      needsHuman: one(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND status='open' AND needs_human=1`),
      today: one(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND created>=?`, day.getTime()),
      messagesToday: one(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conv_id WHERE c.site_id IN ${S} AND m.created>=?`, day.getTime()),
      visitorsOnline, agentsOnline: new Set([...agentStreams].filter(s => s.ws === ws).map(s => s.userId)).size,
      resolved: one(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND status='closed'`),
    });
  }
  if (p === '/api/analytics' && m === 'GET') {
    need('analytics.view'); const S = inSites(scopeSites());
    const days = []; const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i--) {
      const a = d0.getTime() - i * 86400000;
      days.push({ date: new Date(a).toISOString().slice(0, 10),
        chats: db.prepare(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND created>=? AND created<?`).get(a, a + 86400000).n,
        messages: db.prepare(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conv_id WHERE c.site_id IN ${S} AND m.created>=? AND m.created<? AND m.sender!='system'`).get(a, a + 86400000).n });
    }
    const total = db.prepare(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S}`).get().n;
    const botOnly = db.prepare(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND needs_human=0 AND first_reply IS NULL AND bot_active=1`).get().n;
    const fr = db.prepare(`SELECT AVG(first_reply) a FROM conversations WHERE site_id IN ${S} AND first_reply IS NOT NULL`).get().a;
    const cs = db.prepare(`SELECT AVG(rating) a, COUNT(rating) n FROM conversations WHERE site_id IN ${S} AND rating IS NOT NULL`).get();
    const agents = db.prepare(`SELECT u.name, COUNT(DISTINCT c.id) chats, AVG(c.rating) csat FROM conversations c JOIN users u ON u.id=c.assignee_id WHERE c.site_id IN ${S} GROUP BY u.id ORDER BY chats DESC LIMIT 20`).all()
      .map(a => ({ name: a.name, chats: a.chats, csat: a.csat ? Math.round(a.csat * 10) / 10 : null }));
    return send(res, 200, { days, total, agents, botHandledPct: total ? Math.round(botOnly / total * 100) : 0, avgFirstResponseSec: fr ? Math.round(fr / 1000) : null,
      csat: cs.n ? Math.round(cs.a * 10) / 10 : null, ratings: cs.n, contacts: db.prepare(`SELECT COUNT(*) n FROM visitors WHERE site_id IN ${S} AND email IS NOT NULL`).get().n });
  }

  // --- conversations ---
  const loadConv = id => {
    const c = getConv(id);
    if (!c || c.workspace_id !== ws || !ctx.siteIds.includes(c.site_id)) fail(404, 'Conversation not found');
    if (!can('chats.view_all') && c.assignee_id && c.assignee_id !== me.id) fail(404, 'Conversation not found');
    return c;
  };
  if (p === '/api/conversations' && m === 'GET') {
    need('chats.view');
    const st = url.searchParams.get('status'), f = url.searchParams.get('filter'), q = str(url.searchParams.get('q') || '', 100);
    let sql = `SELECT c.* FROM conversations c JOIN visitors v ON v.id=c.visitor_id WHERE c.workspace_id=? AND c.site_id IN ${inSites(scopeSites())}`; const args = [ws];
    if (!can('chats.view_all')) { sql += ' AND (c.assignee_id IS NULL OR c.assignee_id=?)'; args.push(me.id); }
    if (st === 'open' || st === 'closed') { sql += ' AND c.status=?'; args.push(st); }
    if (f === 'mine') { sql += ' AND c.assignee_id=?'; args.push(me.id); }
    if (f === 'unassigned') sql += ' AND c.assignee_id IS NULL';
    if (f === 'human') sql += ' AND c.needs_human=1';
    if (url.searchParams.get('tag')) { sql += ' AND c.tags LIKE ?'; args.push(`%"${str(url.searchParams.get('tag'), 24).replace(/[%_"]/g, '')}"%`); }
    if (q) { sql += ' AND (v.name LIKE ? OR v.email LIKE ? OR c.last_body LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY c.needs_human DESC, c.updated DESC LIMIT 200';
    return send(res, 200, { conversations: db.prepare(sql).all(...args).map(convOut) });
  }
  if ((x = p.match(/^\/api\/conversations\/(\d+)$/)) && m === 'GET') {
    need('chats.view'); const c = loadConv(+x[1]);
    return send(res, 200, { conversation: convOut(c), messages: db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id').all(c.id).map(msgOut) });
  }
  if ((x = p.match(/^\/api\/conversations\/(\d+)\/(messages|note|read|typing|status|assign|upload|tags)$/)) && m === 'POST') {
    need('chats.view'); const c = loadConv(+x[1]);
    const b = await readBody(req, x[2] === 'upload' ? 4_500_000 : 200_000);
    const refresh = () => emitConv(getConv(c.id));
    const S = getSettings(c.site_id);
    const takeOver = () => db.prepare("UPDATE conversations SET bot_active=0, needs_human=0, unread=0, status='open', first_reply=COALESCE(first_reply,?), assignee_id=COALESCE(assignee_id,?) WHERE id=?").run(now() - c.created, me.id, c.id);
    switch (x[2]) {
      case 'messages': {
        need('chats.reply'); const body = str(b.body, 4000); if (!body) fail(400, 'Empty message');
        const out = fraud.record({ kind: 'agent_message', workspaceId: ws, siteId: c.site_id, userId: me.id, summary: body, signals: fraud.scoreAgentMessage({ text: body }) });
        maybeAutoSuspend(ws);
        if (out.blocked) fail(422, 'This message was blocked by platform safety checks (it looks like a request for passwords or payment details with a link). Contact support if this is a mistake.');
        takeOver();
        webhook(c.site_id, 'message.created', { conversation_id: c.id, sender: 'agent', body });
        if (S.emailReplies && !isOnline(c.visitor_id)) emailVisitor(c.id, `${S.brandName}: ${me.name} replied to your message`, `${body}\n\n— ${me.name}, ${S.brandName}`);
        return send(res, 200, { message: addMessage(getConv(c.id), 'agent', body, { senderId: me.id, senderName: me.name }) });
      }
      case 'note': {
        need('chats.reply'); const body = str(b.body, 4000); if (!body) fail(400, 'Empty note');
        return send(res, 200, { message: addMessage(c, 'note', body, { senderId: me.id, senderName: me.name }) });
      }
      case 'upload': {
        need('chats.reply'); const att = await saveUpload(b); takeOver();
        return send(res, 200, { message: addMessage(getConv(c.id), 'agent', `📎 ${att.name}`, { senderId: me.id, senderName: me.name, attachment: att }) });
      }
      case 'tags': {
        need('chats.reply');
        const tags = [...new Set((Array.isArray(b.tags) ? b.tags : []).map(t => str(t, 24).toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '')).filter(Boolean))].slice(0, 8);
        db.prepare('UPDATE conversations SET tags=? WHERE id=?').run(tags.length ? JSON.stringify(tags) : null, c.id); refresh(); return send(res, 200, { tags });
      }
      case 'read': db.prepare('UPDATE conversations SET unread=0 WHERE id=?').run(c.id); refresh(); return send(res, 200, {});
      case 'typing': need('chats.reply'); toVisitor(c.visitor_id, 'typing', { who: 'agent', name: me.name }); return send(res, 200, {});
      case 'status': {
        need('chats.close'); const s = b.status === 'closed' ? 'closed' : 'open';
        db.prepare('UPDATE conversations SET status=?, needs_human=0 WHERE id=?').run(s, c.id);
        if (s === 'closed') {
          addMessage(getConv(c.id), 'system', `${me.name} closed this conversation`); toVisitor(c.visitor_id, 'closed', { rating: !!S.ratingEnabled });
          if (S.emailTranscript) emailVisitor(c.id, `Your conversation with ${S.brandName}`, transcriptText(c.id));
          webhook(c.site_id, 'conversation.closed', { conversation_id: c.id });
        }
        refresh(); return send(res, 200, {});
      }
      case 'assign': {
        need('chats.assign');
        const aid = b.agent_id == null ? null : bodyId(b.agent_id);
        if (aid) {
          const mem = memberOf(aid, ws);
          if (!mem || (mem.site_ids && !JSON.parse(mem.site_ids).includes(c.site_id))) fail(400, "That teammate doesn't have access to this website");
          if (!JSON.parse(mem.permissions).includes('chats.reply')) fail(400, "That teammate's role can't reply to chats");
        }
        const prev = c.assignee_id;
        db.prepare('UPDATE conversations SET assignee_id=? WHERE id=?').run(aid, c.id);
        refresh();
        // agents who lost visibility of this chat (no view_all) get a removal event
        if (prev && prev !== aid) for (const s of agentStreams) if (s.ws === ws && s.userId === prev && !s.viewAll) s.res.write(frame('deleted', { id: c.id }));
        return send(res, 200, {});
      }
    }
  }
  if ((x = p.match(/^\/api\/conversations\/(\d+)$/)) && m === 'DELETE') {
    need('chats.delete'); const c = loadConv(+x[1]);
    db.prepare('DELETE FROM conversations WHERE id=?').run(c.id); log('conversation.deleted', `#${c.id}`);
    toAgents(ws, c.site_id, 'deleted', { id: c.id }); return send(res, 200, {});
  }
  if ((x = p.match(/^\/api\/conversations\/(\d+)\/transcript$/)) && m === 'GET') {
    need('chats.view'); const c = loadConv(+x[1]);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="conversation-${c.id}.txt"` });
    return res.end(transcriptText(c.id));
  }
  // --- spam protection (per workspace) ---
  if ((x = p.match(/^\/api\/conversations\/(\d+)\/block$/)) && m === 'POST') {
    need('chats.block'); const c = loadConv(+x[1]); const b = await readBody(req);
    const v = db.prepare('SELECT * FROM visitors WHERE id=?').get(c.visitor_id);
    fraud.addBlock({ workspaceId: ws, type: 'visitor', value: v.id, reason: str(b.reason, 200) || (b.report ? 'Reported as spam' : 'Blocked by agent'), by: me.name });
    if (b.ip && v.ip) fraud.addBlock({ workspaceId: ws, type: 'ip', value: v.ip, reason: `Blocked with visitor ${v.name || v.id}`, by: me.name });
    if (b.report) {
      const tags = [...new Set([...(c.tags ? JSON.parse(c.tags) : []), 'spam'])];
      db.prepare("UPDATE conversations SET spam=1, status='closed', needs_human=0, tags=? WHERE id=?").run(JSON.stringify(tags), c.id);
      const last = db.prepare("SELECT body FROM messages WHERE conv_id=? AND sender='visitor' ORDER BY id DESC LIMIT 1").get(c.id)?.body || '';
      db.prepare("INSERT INTO fraud_events(created,kind,score,action,workspace_id,site_id,visitor_id,ip,summary,signals,status,reviewed_by,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(now(), 'visitor_message', 100, 'reported', ws, c.site_id, v.id, v.ip, last.slice(0, 500), JSON.stringify([{ code: 'reported_by_agent', weight: 100, detail: `Reported by ${me.name}` }]), 'confirmed', me.name, now());
    }
    for (const r of visitorStreams.get(v.id) || []) r.end();
    log(b.report ? 'visitor.reported' : 'visitor.blocked', `${v.name || v.email || v.id}${b.ip ? ' + IP' : ''}`);
    emitConv(getConv(c.id)); return send(res, 200, {});
  }
  if (p === '/api/spam' && m === 'GET') {
    need('chats.block');
    const blocks = db.prepare('SELECT id, type, value, reason, created_by, created, expires FROM blocklist WHERE workspace_id=? AND (expires IS NULL OR expires>?) ORDER BY id DESC LIMIT 500').all(ws, now());
    const events = db.prepare(`SELECT id, created, score, action, site_id, visitor_id, summary, signals FROM fraud_events WHERE workspace_id=? AND kind='visitor_message' AND site_id IN ${inSites(ctx.siteIds)} ORDER BY id DESC LIMIT 100`).all(ws)
      .map(e => ({ ...e, signals: JSON.parse(e.signals), site_name: siteRow(e.site_id)?.name }));
    const day = now() - 86400_000;
    const counts = db.prepare(`SELECT action, COUNT(*) n FROM fraud_events WHERE workspace_id=? AND kind='visitor_message' AND created>? GROUP BY action`).all(ws, day);
    return send(res, 200, { blocks, events, last24h: Object.fromEntries(counts.map(r => [r.action, r.n])) });
  }
  if (p === '/api/spam/blocks' && m === 'POST') {
    need('chats.block'); const b = await readBody(req);
    const type = ['ip', 'visitor', 'keyword', 'email'].includes(b.type) ? b.type : fail(400, 'Type must be ip, visitor, keyword or email');
    const value = str(b.value, 200).toLowerCase(); if (!value) fail(400, 'Value is required');
    if (type === 'keyword' && value.length < 3) fail(400, 'Blocked words need at least 3 characters');
    fraud.addBlock({ workspaceId: ws, type, value, reason: str(b.reason, 200) || 'Added manually', by: me.name, ttlMs: b.hours ? Math.min(8760, +b.hours) * 3600_000 : null });
    log('block.added', `${type}: ${value}`); return send(res, 200, {});
  }
  if ((x = p.match(/^\/api\/spam\/blocks\/(\d+)$/)) && m === 'DELETE') {
    need('chats.block'); const r = db.prepare('SELECT * FROM blocklist WHERE id=? AND workspace_id=?').get(+x[1], ws); if (!r) fail(404, 'Not found');
    db.prepare('DELETE FROM blocklist WHERE id=?').run(r.id); log('block.removed', `${r.type}: ${r.value}`); return send(res, 200, {});
  }

  if (p === '/api/tags' && m === 'GET') {
    need('chats.view');
    const counts = {}; for (const r of db.prepare(`SELECT tags FROM conversations WHERE workspace_id=? AND site_id IN ${inSites(ctx.siteIds)} AND tags IS NOT NULL`).all(ws)) for (const t of JSON.parse(r.tags)) counts[t] = (counts[t] || 0) + 1;
    return send(res, 200, { tags: Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) });
  }

  // --- visitors & contacts ---
  if (p === '/api/visitors' && m === 'GET') {
    need('chats.view', 'contacts.view');
    const ids = new Set(scopeSites());
    const online = [...visitorStreams.keys()].filter(k => ids.has(Number(k.split(':')[0])));
    const rows = online.length ? db.prepare(`SELECT * FROM visitors WHERE id IN (${online.map(() => '?').join(',')}) ORDER BY last_seen DESC`).all(...online) : [];
    return send(res, 200, { visitors: rows.map(v => ({ ...visitorOut(v), site_name: siteRow(v.site_id)?.name })) });
  }
  if (p === '/api/contacts' && m === 'GET') {
    need('contacts.view'); const q = str(url.searchParams.get('q') || '', 100);
    const rows = db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM conversations c WHERE c.visitor_id=v.id) convs FROM visitors v
      WHERE v.site_id IN ${inSites(scopeSites())} AND (v.email IS NOT NULL OR v.name IS NOT NULL) AND (?='' OR v.name LIKE ? OR v.email LIKE ?) ORDER BY v.last_seen DESC LIMIT 300`).all(q, `%${q}%`, `%${q}%`);
    return send(res, 200, { contacts: rows.map(v => ({ ...visitorOut(v), site_name: siteRow(v.site_id)?.name, notes: v.notes, conversations: v.convs })) });
  }
  if (p === '/api/export/contacts.csv' && m === 'GET') {
    need('contacts.export');
    const q = v => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
    const rows = db.prepare(`SELECT * FROM visitors WHERE site_id IN ${inSites(scopeSites())} AND email IS NOT NULL ORDER BY created DESC`).all();
    log('contacts.exported', `${rows.length} contacts`);
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="contacts.csv"' });
    return res.end('name,email,website,visits,first_seen,last_page\n' + rows.map(v => [v.name, v.email, siteRow(v.site_id)?.name, v.visits, new Date(v.created).toISOString(), v.page].map(q).join(',')).join('\n'));
  }
  if ((x = p.match(/^\/api\/contacts\/([\w:-]+)$/))) {
    need('contacts.view');
    const v = db.prepare('SELECT * FROM visitors WHERE id=?').get(x[1]);
    if (!v || !ctx.siteIds.includes(v.site_id)) fail(404, 'Contact not found');
    if (m === 'GET') {
      let convs = db.prepare('SELECT * FROM conversations WHERE visitor_id=? ORDER BY id DESC').all(v.id);
      if (!can('chats.view_all')) convs = convs.filter(c => !c.assignee_id || c.assignee_id === me.id);
      return send(res, 200, { contact: { ...visitorOut(v), site_name: siteRow(v.site_id)?.name, notes: v.notes }, conversations: convs.map(convOut) });
    }
    if (m === 'PUT') {
      need('contacts.edit');
      const b = await readBody(req); const email = str(b.email, 200).toLowerCase();
      if (email && !EMAIL.test(email)) fail(400, 'Invalid email');
      db.prepare('UPDATE visitors SET name=?, email=?, notes=? WHERE id=?').run(str(b.name, 100) || null, email || null, str(b.notes, 2000) || null, v.id);
      emitPresence(db.prepare('SELECT * FROM visitors WHERE id=?').get(v.id), isOnline(v.id));
      return send(res, 200, {});
    }
  }

  // --- saved replies (workspace-wide) ---
  if (p === '/api/canned') {
    if (m === 'GET') return send(res, 200, { canned: db.prepare('SELECT id, shortcut, text FROM canned WHERE workspace_id=? ORDER BY shortcut').all(ws) });
    if (m === 'POST') {
      need('canned.manage');
      const b = await readBody(req); const sc = str(b.shortcut, 30).toLowerCase().replace(/[^a-z0-9_-]/g, ''), text = str(b.text, 2000);
      if (!sc || !text) fail(400, 'Shortcut and text required');
      try { db.prepare('INSERT INTO canned(workspace_id,shortcut,text) VALUES(?,?,?)').run(ws, sc, text); } catch { fail(409, 'Shortcut already exists'); }
      return send(res, 200, {});
    }
  }
  if ((x = p.match(/^\/api\/canned\/(\d+)$/)) && m === 'DELETE') { need('canned.manage'); db.prepare('DELETE FROM canned WHERE id=? AND workspace_id=?').run(+x[1], ws); return send(res, 200, {}); }

  // --- per-site automation & settings (?site=ID) ---
  if (p === '/api/flows' && m === 'GET') { const sid = siteParam(); return send(res, 200, { flows: db.prepare('SELECT * FROM flows WHERE site_id=? ORDER BY id').all(sid).map(f => ({ ...f, enabled: !!f.enabled, nodes: JSON.parse(f.nodes) })) }); }
  if (p === '/api/flows' && m === 'POST') {
    need('bot.manage'); const sid = siteParam(); const f = flowFields(await readBody(req));
    return send(res, 200, { id: db.prepare('INSERT INTO flows(site_id,name,keywords,nodes,enabled) VALUES(?,?,?,?,?)').run(sid, f.name, f.keywords, f.nodes, f.enabled).lastInsertRowid });
  }
  if ((x = p.match(/^\/api\/flows\/(\d+)$/))) {
    need('bot.manage'); const sid = siteParam();
    if (m === 'PUT') { const f = flowFields(await readBody(req)); db.prepare('UPDATE flows SET name=?,keywords=?,nodes=?,enabled=? WHERE id=? AND site_id=?').run(f.name, f.keywords, f.nodes, f.enabled, +x[1], sid); return send(res, 200, {}); }
    if (m === 'DELETE') { db.prepare('DELETE FROM flows WHERE id=? AND site_id=?').run(+x[1], sid); return send(res, 200, {}); }
  }
  if (p === '/api/kb') {
    const sid = siteParam();
    if (m === 'GET') return send(res, 200, { kb: db.prepare('SELECT id, question, answer FROM kb WHERE site_id=? ORDER BY id').all(sid) });
    if (m === 'POST') {
      need('bot.manage'); const b = await readBody(req); const q = str(b.question, 300), a = str(b.answer, 3000);
      if (!q || !a) fail(400, 'Question and answer required');
      db.prepare('INSERT INTO kb(site_id,question,answer) VALUES(?,?,?)').run(sid, q, a); return send(res, 200, {});
    }
  }
  if ((x = p.match(/^\/api\/kb\/(\d+)$/)) && m === 'DELETE') { need('bot.manage'); db.prepare('DELETE FROM kb WHERE id=? AND site_id=?').run(+x[1], siteParam()); return send(res, 200, {}); }
  if (p === '/api/triggers' && m === 'GET') { const sid = siteParam(); return send(res, 200, { triggers: db.prepare('SELECT * FROM triggers WHERE site_id=? ORDER BY id').all(sid).map(t => ({ ...t, open_chat: !!t.open_chat, enabled: !!t.enabled })) }); }
  if (p === '/api/triggers' && m === 'POST') {
    need('bot.manage'); const sid = siteParam(); const t = triggerFields(await readBody(req));
    return send(res, 200, { id: db.prepare('INSERT INTO triggers(site_id,name,url_contains,delay,message,open_chat,enabled) VALUES(?,?,?,?,?,?,?)').run(sid, t.name, t.url, t.delay, t.message, t.open, t.enabled).lastInsertRowid });
  }
  if ((x = p.match(/^\/api\/triggers\/(\d+)$/))) {
    need('bot.manage'); const sid = siteParam();
    if (m === 'PUT') { const t = triggerFields(await readBody(req)); db.prepare('UPDATE triggers SET name=?,url_contains=?,delay=?,message=?,open_chat=?,enabled=? WHERE id=? AND site_id=?').run(t.name, t.url, t.delay, t.message, t.open, t.enabled, +x[1], sid); return send(res, 200, {}); }
    if (m === 'DELETE') { db.prepare('DELETE FROM triggers WHERE id=? AND site_id=?').run(+x[1], sid); return send(res, 200, {}); }
  }
  if (p === '/api/rules' && m === 'GET') { const sid = siteParam(); return send(res, 200, { rules: db.prepare('SELECT * FROM rules WHERE site_id=? ORDER BY position, id').all(sid).map(parseRule) }); }
  if (p === '/api/rules' && m === 'POST') {
    need('bot.manage'); const sid = siteParam(); const r = ruleFields(await readBody(req));
    const pos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 n FROM rules WHERE site_id=?').get(sid).n;
    return send(res, 200, { id: db.prepare('INSERT INTO rules(site_id,name,keywords,reply,buttons,handoff,enabled,position) VALUES(?,?,?,?,?,?,?,?)').run(sid, r.name, r.keywords, r.reply, r.buttons, r.handoff, r.enabled, pos).lastInsertRowid });
  }
  if ((x = p.match(/^\/api\/rules\/(\d+)$/))) {
    need('bot.manage'); const sid = siteParam();
    if (m === 'PUT') { const r = ruleFields(await readBody(req)); db.prepare('UPDATE rules SET name=?,keywords=?,reply=?,buttons=?,handoff=?,enabled=? WHERE id=? AND site_id=?').run(r.name, r.keywords, r.reply, r.buttons, r.handoff, r.enabled, +x[1], sid); return send(res, 200, {}); }
    if (m === 'DELETE') { db.prepare('DELETE FROM rules WHERE id=? AND site_id=?').run(+x[1], sid); return send(res, 200, {}); }
  }
  if (p === '/api/bot/test' && m === 'POST') {
    const sid = siteParam(); const b = await readBody(req); const text = str(b.text, 500);
    const flow = matchFlow(sid, text), rule = !flow && matchRule(sid, text), kb = !flow && !rule && matchKb(sid, text);
    return send(res, 200, { flow: flow ? { name: flow.name } : null, rule: rule || null, kb: kb || null });
  }
  if (p === '/api/settings') {
    const sid = siteParam();
    if (m === 'GET') return send(res, 200, { settings: getSettings(sid) });
    if (m === 'PUT') {
      const b = await readBody(req);
      const botKeys = ['botEnabled', 'aiEnabled', 'aiInstructions'], keys = Object.keys(b);
      if (keys.length === 1 && keys[0] === 'spamFilter') need('chats.block', 'settings.manage');
      else if (keys.every(k => botKeys.includes(k))) need('bot.manage');
      else need('settings.manage');
      if (b.color && !/^#[0-9a-fA-F]{6}$/.test(b.color)) fail(400, 'Color must be a hex value like #4f46e5');
      if (b.position && !['left', 'right'].includes(b.position)) fail(400, 'Bad position');
      if (b.launcherStyle && !['circle', 'pill'].includes(b.launcherStyle)) fail(400, 'Bad launcher style');
      if (b.theme && !['light', 'dark', 'auto'].includes(b.theme)) fail(400, 'Bad theme');
      if (b.spamFilter && !['off', 'normal', 'strict'].includes(b.spamFilter)) fail(400, 'Spam filter must be off, normal or strict');
      if (b.avatarUrl && !/^https?:\/\/|^\//.test(b.avatarUrl)) fail(400, 'Avatar must be an http(s) URL');
      if ('proactiveDelay' in b) b.proactiveDelay = Math.max(0, Math.min(600, Number(b.proactiveDelay) || 0));
      for (const k of ['gradient', 'prechatForm', 'showBranding', 'emailNotifications', 'emailReplies', 'emailTranscript', 'askEmail', 'botEnabled', 'proactiveEnabled', 'aiEnabled', 'ratingEnabled', 'businessHoursEnabled']) if (k in b) b[k] = !!b[k];
      for (const k of ['brandName', 'title', 'subtitle', 'greeting', 'offlineMessage', 'handoffMessage', 'fallbackMessage', 'proactiveMessage', 'allowedOrigins', 'aiInstructions', 'launcherLabel', 'avatarUrl', 'webhookUrl', 'timezone', 'hoursStart', 'hoursEnd', 'hoursDays']) if (k in b) b[k] = str(b[k], 500);
      if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { fail(400, 'Unknown timezone'); } }
      for (const k of ['hoursStart', 'hoursEnd']) if (b[k] && !/^\d\d:\d\d$/.test(b[k])) fail(400, 'Times must look like 09:00');
      if (b.webhookUrl && !/^https?:\/\//.test(b.webhookUrl)) fail(400, 'Webhook URL must start with http(s)://');
      setSettings(sid, b); log('settings.updated', `${siteRow(sid).name}: ${Object.keys(b).join(', ')}`);
      return send(res, 200, { settings: getSettings(sid) });
    }
  }
  if (p === '/api/mail/test' && m === 'POST') {
    need('settings.manage');
    try { await sendMail({ to: me.email, subject: 'Chatly test email', text: 'Email delivery from Chatly is working.' }); } catch (e) { fail(400, e.message); }
    return send(res, 200, {});
  }

  // --- team: members ---
  if (p === '/api/members' && m === 'GET') {
    const rows = db.prepare('SELECT u.id, u.name, u.email, m.role_id, r.name role, m.site_ids, r.permissions FROM members m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.workspace_id=? ORDER BY u.name').all(ws);
    const online = new Set([...agentStreams].filter(s => s.ws === ws).map(s => s.userId));
    return send(res, 200, { members: rows.map(r => ({ id: r.id, name: r.name, email: can('team.manage') ? r.email : undefined, role_id: r.role_id, role: r.role,
      site_ids: r.site_ids ? JSON.parse(r.site_ids) : null, can_reply: JSON.parse(r.permissions).includes('chats.reply'), online: online.has(r.id) })) });
  }
  const assertCanGrant = roleId => {
    const r = db.prepare('SELECT * FROM roles WHERE id=? AND workspace_id=?').get(roleId, ws);
    if (!r) fail(400, 'Role not found');
    if (!isSubset(rolePerms(r.id), ctx.perms)) fail(403, "You can't grant a role with more permissions than your own");
    return r;
  };
  if (p === '/api/members' && m === 'POST') {
    need('team.manage'); const b = await readBody(req);
    const email = str(b.email, 200).toLowerCase(), name = str(b.name, 80);
    if (!EMAIL.test(email)) fail(400, 'A valid email is required');
    const role = assertCanGrant(bodyId(b.role_id)), siteIds = cleanSiteIds(ws, b.site_ids);
    let u = db.prepare('SELECT * FROM users WHERE email=?').get(email), created = false;
    if (!u) {
      if (!name) fail(400, 'Name is required for a new account');
      if (String(b.password || '').length < 8) fail(400, 'Temporary password must be at least 8 characters');
      u = { id: Number(db.prepare('INSERT INTO users(name,email,pass,created) VALUES(?,?,?,?)').run(name, email, hashPassword(String(b.password)), now()).lastInsertRowid), name };
      created = true;
    } else if (memberOf(u.id, ws)) fail(409, 'This person is already in the workspace');
    db.prepare('INSERT INTO members(user_id,workspace_id,role_id,site_ids,created) VALUES(?,?,?,?,?)').run(u.id, ws, role.id, siteIds ? JSON.stringify(siteIds) : null, now());
    log('member.added', `${email} as ${role.name}`);
    if (mailConfigured()) sendMail({ to: email, subject: `You've been added to ${db.prepare('SELECT name FROM workspaces WHERE id=?').get(ws).name} on Chatly`,
      text: `${me.name} added you as ${role.name}. Sign in at the Chatly dashboard with ${email}${created ? ' and the temporary password you were given' : ''}.` }).catch(logMailErr);
    return send(res, 200, { created });
  }
  if ((x = p.match(/^\/api\/members\/(\d+)$/))) {
    need('team.manage'); const uid = +x[1];
    const mem = memberOf(uid, ws); if (!mem) fail(404, 'Member not found');
    if (uid === me.id) fail(400, "You can't change your own access — ask another admin");
    if (!isSubset(rolePerms(mem.role_id), ctx.perms)) fail(403, 'This person has permissions you do not have, so you cannot change them');
    const target = db.prepare('SELECT name, email FROM users WHERE id=?').get(uid);
    const isOwner = db.prepare('SELECT system FROM roles WHERE id=?').get(mem.role_id).system;
    if (m === 'PUT') {
      const b = await readBody(req); const role = assertCanGrant(bodyId(b.role_id)); const siteIds = cleanSiteIds(ws, b.site_ids);
      if (isOwner && !role.system && ownerCount(ws) <= 1) fail(400, 'A workspace needs at least one Owner');
      db.prepare('UPDATE members SET role_id=?, site_ids=? WHERE user_id=? AND workspace_id=?').run(role.id, siteIds ? JSON.stringify(siteIds) : null, uid, ws);
      log('member.updated', `${target.email} → ${role.name}${siteIds ? ` (${siteIds.length} sites)` : ''}`); kickUser(uid, ws);
      return send(res, 200, {});
    }
    if (m === 'DELETE') {
      if (isOwner && ownerCount(ws) <= 1) fail(400, 'A workspace needs at least one Owner');
      db.prepare('DELETE FROM members WHERE user_id=? AND workspace_id=?').run(uid, ws);
      db.prepare('UPDATE conversations SET assignee_id=NULL WHERE workspace_id=? AND assignee_id=?').run(ws, uid);
      db.prepare('UPDATE sessions SET workspace_id=NULL WHERE user_id=? AND workspace_id=?').run(uid, ws);
      log('member.removed', target.email); kickUser(uid, ws);
      return send(res, 200, {});
    }
  }

  // --- team: roles ---
  if (p === '/api/roles' && m === 'GET') {
    need('team.manage', 'roles.manage');
    return send(res, 200, { roles: db.prepare('SELECT * FROM roles WHERE workspace_id=? ORDER BY system DESC, id').all(ws).map(roleOut) });
  }
  const roleFields = async () => {
    const b = await readBody(req); const name = str(b.name, 40); if (!name) fail(400, 'Role name is required');
    const perms = cleanPerms(b.permissions);
    if (!perms.length) fail(400, 'Pick at least one permission');
    if (!isSubset(new Set(perms), ctx.perms)) fail(403, "You can't give a role permissions you don't have yourself");
    if (db.prepare('SELECT 1 FROM roles WHERE workspace_id=? AND lower(name)=lower(?) AND id!=?').get(ws, name, Number(x?.[1]) || 0)) fail(409, 'A role with that name already exists');
    return { name, perms };
  };
  if (p === '/api/roles' && m === 'POST') {
    need('roles.manage'); const r = await roleFields();
    const id = db.prepare('INSERT INTO roles(workspace_id,name,permissions) VALUES(?,?,?)').run(ws, r.name, JSON.stringify(r.perms)).lastInsertRowid;
    log('role.created', r.name); return send(res, 200, { id });
  }
  if ((x = p.match(/^\/api\/roles\/(\d+)$/))) {
    need('roles.manage');
    const role = db.prepare('SELECT * FROM roles WHERE id=? AND workspace_id=?').get(+x[1], ws); if (!role) fail(404, 'Role not found');
    if (role.system) fail(400, 'The Owner role always has every permission and cannot be changed');
    if (!isSubset(rolePerms(role.id), ctx.perms)) fail(403, 'This role has permissions you do not have, so you cannot change it');
    if (m === 'PUT') {
      const r = await roleFields();
      db.prepare('UPDATE roles SET name=?, permissions=? WHERE id=?').run(r.name, JSON.stringify(r.perms), role.id);
      log('role.updated', `${r.name}: ${r.perms.join(', ')}`);
      for (const u of db.prepare('SELECT user_id FROM members WHERE role_id=?').all(role.id)) kickUser(u.user_id, ws);
      return send(res, 200, {});
    }
    if (m === 'DELETE') {
      if (db.prepare('SELECT COUNT(*) n FROM members WHERE role_id=?').get(role.id).n) fail(400, 'Move everyone off this role before deleting it');
      db.prepare('DELETE FROM roles WHERE id=?').run(role.id); log('role.deleted', role.name); return send(res, 200, {});
    }
  }
  if (p === '/api/audit' && m === 'GET') {
    need('audit.view');
    return send(res, 200, { entries: db.prepare('SELECT user_name, action, detail, created FROM audit WHERE workspace_id=? ORDER BY id DESC LIMIT 300').all(ws) });
  }
  fail(404, 'Not found');
}
/** Suspends a workspace automatically when its fraud risk crosses the platform threshold (only if enabled). */
function maybeAutoSuspend(ws) {
  const f = fraud.fraudSettings(); if (!f.autoSuspend || f.fraudMode !== 'enforce') return;
  const w = db.prepare('SELECT suspended, risk_score, name FROM workspaces WHERE id=?').get(ws);
  if (!w || w.suspended || w.risk_score < f.autoSuspendThreshold) return;
  const reason = `Automatically suspended for review: suspected abuse (risk ${w.risk_score})`;
  db.prepare('UPDATE workspaces SET suspended=1, suspended_reason=? WHERE id=?').run(reason, ws);
  audit(ws, null, 'workspace.suspended', reason);
  db.prepare('INSERT INTO platform_audit(user_id,user_name,action,detail,created) VALUES(?,?,?,?,?)').run(null, 'fraud engine', 'workspace.auto_suspended', `${w.name} (#${ws}) risk ${w.risk_score}`, now());
  kickWorkspace(ws);
}

// ---------- platform (operator) console ----------
function platformAudit(user, action, detail) {
  db.prepare('INSERT INTO platform_audit(user_id,user_name,action,detail,created) VALUES(?,?,?,?,?)').run(user.id, user.name, action, detail ? String(detail).slice(0, 500) : null, now());
}
const wsOwner = id => db.prepare("SELECT u.email, u.name FROM members m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.workspace_id=? AND r.system=1 ORDER BY m.created LIMIT 1").get(id);
function workspaceOut(w) {
  const n = (q, ...a) => db.prepare(q).get(...a).n;
  const live = [...agentStreams].filter(s => s.ws === w.id).length;
  return { id: w.id, name: w.name, plan: w.plan, suspended: !!w.suspended, suspended_reason: w.suspended_reason, created: w.created, owner: wsOwner(w.id) || null,
    sites: n('SELECT COUNT(*) n FROM sites WHERE workspace_id=?', w.id), members: n('SELECT COUNT(*) n FROM members WHERE workspace_id=?', w.id),
    conversations: n('SELECT COUNT(*) n FROM conversations WHERE workspace_id=?', w.id),
    last_activity: db.prepare('SELECT MAX(updated) t FROM conversations WHERE workspace_id=?').get(w.id).t, agents_online: live };
}
async function platformRoute(req, res, url, ctx) {
  const me = ctx.user, p = url.pathname.slice('/api/platform'.length), m = req.method; let x;
  if (me.platform_role !== 'superadmin') fail(403, 'Platform admins only');
  const log = (a, d) => platformAudit(me, a, d);
  const n = (q, ...a) => db.prepare(q).get(...a).n;

  if (p === '/overview' && m === 'GET') {
    const day = new Date(); day.setHours(0, 0, 0, 0); const d0 = day.getTime();
    const signups = []; for (let i = 13; i >= 0; i--) { const a = d0 - i * 86400000; signups.push({ date: new Date(a).toISOString().slice(0, 10), workspaces: n('SELECT COUNT(*) n FROM workspaces WHERE created>=? AND created<?', a, a + 86400000), users: n('SELECT COUNT(*) n FROM users WHERE created>=? AND created<?', a, a + 86400000) }); }
    const plans = db.prepare('SELECT plan, COUNT(*) n FROM workspaces GROUP BY plan ORDER BY n DESC').all();
    const top = db.prepare('SELECT workspace_id id, COUNT(*) n FROM conversations WHERE created>=? GROUP BY workspace_id ORDER BY n DESC LIMIT 5').all(d0 - 30 * 86400000)
      .map(r => ({ id: r.id, name: db.prepare('SELECT name FROM workspaces WHERE id=?').get(r.id)?.name, conversations: r.n }));
    return send(res, 200, {
      workspaces: n('SELECT COUNT(*) n FROM workspaces'), suspended: n('SELECT COUNT(*) n FROM workspaces WHERE suspended=1'), users: n('SELECT COUNT(*) n FROM users'),
      sites: n('SELECT COUNT(*) n FROM sites'), installed: n('SELECT COUNT(*) n FROM sites WHERE last_seen_at IS NOT NULL'),
      conversations: n('SELECT COUNT(*) n FROM conversations'), conversationsToday: n('SELECT COUNT(*) n FROM conversations WHERE created>=?', d0),
      messagesToday: n('SELECT COUNT(*) n FROM messages WHERE created>=?', d0), visitorsOnline: visitorStreams.size,
      agentsOnline: new Set([...agentStreams].map(s => s.userId)).size, activeWorkspaces7d: n('SELECT COUNT(DISTINCT workspace_id) n FROM conversations WHERE updated>=?', d0 - 7 * 86400000),
      signups, plans, top, mail: mailConfigured(), ai: !!process.env.ANTHROPIC_API_KEY,
    });
  }
  if (p === '/workspaces' && m === 'GET') {
    const q = str(url.searchParams.get('q') || '', 100), f = url.searchParams.get('filter');
    let sql = 'SELECT * FROM workspaces w WHERE 1=1'; const args = [];
    if (q) { sql += ' AND (w.name LIKE ? OR w.id IN (SELECT m.workspace_id FROM members m JOIN users u ON u.id=m.user_id WHERE u.email LIKE ?) OR w.id IN (SELECT workspace_id FROM sites WHERE domain LIKE ? OR name LIKE ?))'; args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (f === 'suspended') sql += ' AND w.suspended=1';
    if (f && f.startsWith('plan:')) { sql += ' AND w.plan=?'; args.push(f.slice(5)); }
    sql += ' ORDER BY w.created DESC LIMIT 500';
    return send(res, 200, { workspaces: db.prepare(sql).all(...args).map(workspaceOut) });
  }
  if ((x = p.match(/^\/workspaces\/(\d+)$/))) {
    const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(+x[1]); if (!w) fail(404, 'Workspace not found');
    if (m === 'GET') {
      const members = db.prepare('SELECT u.id, u.name, u.email, u.last_login, u.disabled, r.name role FROM members m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.workspace_id=? ORDER BY r.system DESC, u.name').all(w.id);
      const sites = db.prepare('SELECT * FROM sites WHERE workspace_id=? ORDER BY id').all(w.id).map(s => ({ id: s.id, name: s.name, domain: s.domain, created: s.created, last_seen_at: s.last_seen_at, last_origin: s.last_origin,
        conversations: n('SELECT COUNT(*) n FROM conversations WHERE site_id=?', s.id) }));
      return send(res, 200, { workspace: workspaceOut(w), members: members.map(u => ({ ...u, disabled: !!u.disabled })), sites,
        audit: db.prepare('SELECT user_name, action, detail, created FROM audit WHERE workspace_id=? ORDER BY id DESC LIMIT 30').all(w.id) });
    }
    if (m === 'PUT') {
      const b = await readBody(req), changes = [];
      if ('plan' in b) { const plan = str(b.plan, 30).toLowerCase(); if (!getPlatform().plans.split(',').map(x => x.trim()).includes(plan)) fail(400, 'Unknown plan'); db.prepare('UPDATE workspaces SET plan=? WHERE id=?').run(plan, w.id); changes.push('plan=' + plan); }
      if ('name' in b) { const nm = str(b.name, 80); if (!nm) fail(400, 'Name is required'); db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(nm, w.id); changes.push('name=' + nm); }
      if ('suspended' in b) {
        const reason = b.suspended ? (str(b.reason, 200) || 'Suspended by the platform') : null;
        db.prepare('UPDATE workspaces SET suspended=?, suspended_reason=? WHERE id=?').run(b.suspended ? 1 : 0, reason, w.id);
        changes.push(b.suspended ? 'suspended: ' + reason : 'reactivated');
        if (b.suspended) kickWorkspace(w.id);
        audit(w.id, { id: me.id, name: `${me.name} (platform)` }, b.suspended ? 'workspace.suspended' : 'workspace.reactivated', reason);
      }
      log('workspace.updated', `${w.name} (#${w.id}): ${changes.join(', ')}`);
      return send(res, 200, { workspace: workspaceOut(db.prepare('SELECT * FROM workspaces WHERE id=?').get(w.id)) });
    }
    if (m === 'DELETE') {
      const b = await readBody(req);
      if (b.confirm !== w.name) fail(400, 'Type the workspace name to confirm deletion');
      kickWorkspace(w.id);
      db.prepare('UPDATE sessions SET workspace_id=NULL WHERE workspace_id=?').run(w.id);
      db.prepare('DELETE FROM workspaces WHERE id=?').run(w.id);
      log('workspace.deleted', `${w.name} (#${w.id})`); return send(res, 200, {});
    }
  }
  if (p === '/users' && m === 'GET') {
    const q = str(url.searchParams.get('q') || '', 100);
    const rows = db.prepare(`SELECT u.id, u.name, u.email, u.created, u.last_login, u.disabled, u.platform_role, (SELECT COUNT(*) FROM members m WHERE m.user_id=u.id) workspaces
      FROM users u WHERE (?='' OR u.name LIKE ? OR u.email LIKE ?) ORDER BY u.created DESC LIMIT 500`).all(q, `%${q}%`, `%${q}%`);
    const online = new Set([...agentStreams].map(s => s.userId));
    return send(res, 200, { users: rows.map(u => ({ ...u, disabled: !!u.disabled, online: online.has(u.id),
      memberships: db.prepare('SELECT w.id, w.name, r.name role FROM members m JOIN workspaces w ON w.id=m.workspace_id JOIN roles r ON r.id=m.role_id WHERE m.user_id=?').all(u.id) })) });
  }
  if ((x = p.match(/^\/users\/(\d+)(\/reset-password)?$/))) {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(+x[1]); if (!u) fail(404, 'User not found');
    if (x[2] && m === 'POST') {
      const temp = randomBytes(9).toString('base64url');
      db.prepare('UPDATE users SET pass=? WHERE id=?').run(hashPassword(temp), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); kickUser(u.id);
      log('user.password_reset', u.email);
      let emailed = false;
      if (mailConfigured()) { try { await sendMail({ to: u.email, subject: 'Your Chatly password was reset', text: `A platform administrator reset your password.\n\nTemporary password: ${temp}\n\nSign in and change it under Settings → My account.` }); emailed = true; } catch (e) { logMailErr(e); } }
      return send(res, 200, { temporaryPassword: emailed ? null : temp, emailed });
    }
    if (m === 'PUT') {
      const b = await readBody(req), changes = [];
      if (u.id === me.id && ('disabled' in b || 'platform_role' in b)) fail(400, "You can't change your own platform access");
      if ('disabled' in b) {
        db.prepare('UPDATE users SET disabled=? WHERE id=?').run(b.disabled ? 1 : 0, u.id); changes.push(b.disabled ? 'disabled' : 'enabled');
        if (b.disabled) { db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); kickUser(u.id); }
      }
      if ('platform_role' in b) {
        const role = b.platform_role === 'superadmin' ? 'superadmin' : null;
        if (!role && u.platform_role === 'superadmin' && n("SELECT COUNT(*) n FROM users WHERE platform_role='superadmin' AND disabled=0") <= 1) fail(400, 'The platform needs at least one active platform admin');
        db.prepare('UPDATE users SET platform_role=? WHERE id=?').run(role, u.id); changes.push(role ? 'made platform admin' : 'removed platform admin');
      }
      log('user.updated', `${u.email}: ${changes.join(', ')}`); return send(res, 200, {});
    }
  }
  if (p === '/settings') {
    if (m === 'GET') return send(res, 200, { settings: getPlatform(), signupForcedOff: process.env.ALLOW_SIGNUP === '0' });
    if (m === 'PUT') {
      const b = await readBody(req), patch = {};
      if ('allowSignup' in b) patch.allowSignup = !!b.allowSignup;
      if ('announcement' in b) patch.announcement = str(b.announcement, 300);
      if ('plans' in b) { const plans = str(b.plans, 200).split(',').map(x => x.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')).filter(Boolean); if (!plans.length) fail(400, 'Add at least one plan'); patch.plans = [...new Set(plans)].join(','); }
      setPlatform(patch); log('platform.settings', Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', '));
      return send(res, 200, { settings: getPlatform() });
    }
  }
  if (p === '/audit' && m === 'GET') return send(res, 200, { entries: db.prepare('SELECT user_name, action, detail, created FROM platform_audit ORDER BY id DESC LIMIT 300').all() });

  // --- fraud & abuse ---
  const eventOut = e => ({ ...e, signals: JSON.parse(e.signals), workspace_name: e.workspace_id ? db.prepare('SELECT name FROM workspaces WHERE id=?').get(e.workspace_id)?.name : null,
    user_email: e.user_id ? db.prepare('SELECT email FROM users WHERE id=?').get(e.user_id)?.email : e.email });
  if (p === '/fraud/overview' && m === 'GET') {
    const day = now() - 86400_000;
    const byKind = db.prepare('SELECT kind, action, COUNT(*) n FROM fraud_events WHERE created>? GROUP BY kind, action').all(day);
    const risky = db.prepare('SELECT * FROM workspaces WHERE risk_score>0 ORDER BY risk_score DESC LIMIT 10').all().map(w => ({ ...workspaceOut(w), risk_score: w.risk_score }));
    return send(res, 200, { byKind, open: n("SELECT COUNT(*) n FROM fraud_events WHERE status='open'"), blocked24h: n("SELECT COUNT(*) n FROM fraud_events WHERE created>? AND action='blocked'", day),
      lockedAccounts: n('SELECT COUNT(*) n FROM users WHERE locked_until>?', now()), blocklist: n('SELECT COUNT(*) n FROM blocklist WHERE workspace_id IS NULL AND (expires IS NULL OR expires>?)', now()),
      risky, settings: fraud.fraudSettings() });
  }
  if (p === '/fraud/events' && m === 'GET') {
    const st = url.searchParams.get('status') || 'open', kind = url.searchParams.get('kind');
    let sql = 'SELECT * FROM fraud_events WHERE 1=1'; const args = [];
    if (st !== 'all') { sql += ' AND status=?'; args.push(st); }
    if (kind) { sql += ' AND kind=?'; args.push(kind); }
    sql += ' ORDER BY score DESC, id DESC LIMIT 200';
    return send(res, 200, { events: db.prepare(sql).all(...args).map(eventOut) });
  }
  if ((x = p.match(/^\/fraud\/events\/(\d+)$/)) && m === 'POST') {
    const e = db.prepare('SELECT * FROM fraud_events WHERE id=?').get(+x[1]); if (!e) fail(404, 'Event not found');
    const b = await readBody(req), a = b.actions || {}, done = [];
    if (!['confirm', 'dismiss'].includes(b.decision)) fail(400, 'Decision must be confirm or dismiss');
    db.prepare('UPDATE fraud_events SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?').run(b.decision === 'confirm' ? 'confirmed' : 'dismissed', me.name, now(), e.id);
    if (b.decision === 'confirm') {
      const reason = `Fraud review #${e.id}: ${e.summary?.slice(0, 80) || e.kind}`;
      if (a.block_ip && e.ip) { fraud.addBlock({ type: 'ip', value: e.ip, reason, by: me.name, ttlMs: a.ttl_hours ? a.ttl_hours * 3600_000 : null }); done.push('blocked IP ' + e.ip); }
      const email = e.email || (e.user_id && db.prepare('SELECT email FROM users WHERE id=?').get(e.user_id)?.email);
      if (a.block_email && email) { fraud.addBlock({ type: 'email', value: email, reason, by: me.name }); done.push('blocked email ' + email); }
      if (a.block_domain && email) { fraud.addBlock({ type: 'email_domain', value: email.split('@')[1], reason, by: me.name }); done.push('blocked domain ' + email.split('@')[1]); }
      if (a.block_visitor && e.visitor_id) { fraud.addBlock({ type: 'visitor', value: e.visitor_id, reason, by: me.name }); for (const r of visitorStreams.get(e.visitor_id) || []) r.end(); done.push('blocked visitor'); }
      if (a.disable_user && e.user_id && e.user_id !== me.id) { db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(e.user_id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(e.user_id); kickUser(e.user_id); done.push('disabled user'); }
      if (a.suspend_workspace && e.workspace_id) {
        const why = 'Suspended after fraud review';
        db.prepare('UPDATE workspaces SET suspended=1, suspended_reason=? WHERE id=?').run(why, e.workspace_id); audit(e.workspace_id, { id: me.id, name: `${me.name} (platform)` }, 'workspace.suspended', why);
        kickWorkspace(e.workspace_id); done.push('suspended workspace');
      }
    }
    if (e.workspace_id) fraud.bumpWorkspaceRisk(e.workspace_id);
    log(`fraud.${b.decision}`, `#${e.id} ${e.kind} score ${e.score}${done.length ? ' → ' + done.join(', ') : ''}`);
    return send(res, 200, { done });
  }
  if (p === '/fraud/blocklist') {
    if (m === 'GET') return send(res, 200, { blocks: db.prepare('SELECT * FROM blocklist WHERE workspace_id IS NULL AND (expires IS NULL OR expires>?) ORDER BY id DESC LIMIT 1000').all(now()) });
    if (m === 'POST') {
      const b = await readBody(req);
      const type = ['ip', 'email', 'email_domain', 'keyword', 'visitor'].includes(b.type) ? b.type : fail(400, 'Unknown block type');
      const value = str(b.value, 200).toLowerCase(); if (!value) fail(400, 'Value is required');
      if (type === 'email' && !EMAIL.test(value)) fail(400, 'Not a valid email');
      if (type === 'email_domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) fail(400, 'Not a valid domain');
      fraud.addBlock({ type, value, reason: str(b.reason, 200) || 'Added by platform admin', by: me.name, ttlMs: b.hours ? Math.min(8760, +b.hours) * 3600_000 : null });
      log('fraud.block_added', `${type}: ${value}`); return send(res, 200, {});
    }
  }
  if ((x = p.match(/^\/fraud\/blocklist\/(\d+)$/)) && m === 'DELETE') {
    const r = db.prepare('SELECT * FROM blocklist WHERE id=? AND workspace_id IS NULL').get(+x[1]); if (!r) fail(404, 'Not found');
    db.prepare('DELETE FROM blocklist WHERE id=?').run(r.id); log('fraud.block_removed', `${r.type}: ${r.value}`); return send(res, 200, {});
  }
  if (p === '/fraud/unlock' && m === 'POST') {
    const b = await readBody(req); const email = str(b.email, 200).toLowerCase();
    db.prepare('UPDATE users SET locked_until=NULL WHERE email=?').run(email); db.prepare('DELETE FROM login_failures WHERE email=?').run(email);
    log('fraud.unlocked', email); return send(res, 200, {});
  }
  if (p === '/fraud/settings' && m === 'PUT') {
    const b = await readBody(req), patch = {};
    if ('fraudMode' in b) patch.fraudMode = b.fraudMode === 'monitor' ? 'monitor' : 'enforce';
    for (const k of ['reviewThreshold', 'blockThreshold', 'autoSuspendThreshold']) if (k in b) { const v = Math.round(Number(b[k])); if (!(v >= 1 && v <= 1000)) fail(400, `${k} must be between 1 and 1000`); patch[k] = v; }
    if ('autoSuspend' in b) patch.autoSuspend = !!b.autoSuspend;
    const merged = { ...fraud.fraudSettings(), ...patch };
    if (merged.reviewThreshold >= merged.blockThreshold) fail(400, 'Review threshold must be lower than the block threshold');
    setPlatform(patch); log('fraud.settings', Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', '));
    return send(res, 200, { settings: fraud.fraudSettings() });
  }
  if (p === '/fraud/rescan' && m === 'POST') {
    const rows = db.prepare('SELECT id FROM workspaces').all(); for (const r of rows) fraud.bumpWorkspaceRisk(r.id);
    return send(res, 200, { scanned: rows.length });
  }
  fail(404, 'Not found');
}

function triggerFields(b) {
  const name = str(b.name, 80), message = str(b.message, 500);
  if (!name || !message) fail(400, 'Name and message are required');
  return { name, message, url: str(b.url_contains, 200), delay: Math.max(0, Math.min(600, Math.round(Number(b.delay)) || 0)), open: b.open_chat ? 1 : 0, enabled: b.enabled === false ? 0 : 1 };
}
function flowFields(b) {
  const name = str(b.name, 80), keywords = str(b.keywords, 500);
  if (!name || !keywords) fail(400, 'Name and trigger keywords are required');
  const nodes = (Array.isArray(b.nodes) ? b.nodes : []).map(n => ({ id: str(n?.id, 30), type: n?.type, text: str(n?.text, 1000),
    ...(n?.type === 'ask' ? { field: n.field } : {}), ...(n?.type === 'choice' ? { options: (Array.isArray(n.options) ? n.options : []).map(o => ({ label: str(o?.label, 40), next: str(o?.next, 30) })) } : {}),
    ...(['message', 'ask'].includes(n?.type) ? { next: str(n.next, 30) } : {}) }));
  const err = validateNodes(nodes); if (err) fail(400, err);
  return { name, keywords, nodes: JSON.stringify(nodes), enabled: b.enabled === false ? 0 : 1 };
}
function ruleFields(b) {
  const name = str(b.name, 80), keywords = str(b.keywords, 500), reply = str(b.reply, 2000);
  if (!name || !keywords || !reply) fail(400, 'Name, keywords and reply are required');
  const buttons = (Array.isArray(b.buttons) ? b.buttons : []).map(x => str(x, 40)).filter(Boolean).slice(0, 5);
  return { name, keywords, reply, buttons: JSON.stringify(buttons), handoff: b.handoff ? 1 : 0, enabled: b.enabled === false ? 0 : 1 };
}

// ---------- static + server ----------
async function serveUpload(res, url) {
  const name = path.basename(decodeURIComponent(url.pathname));
  const ext = name.split('.').pop();
  const type = Object.keys(UPLOAD_TYPES).find(t => UPLOAD_TYPES[t] === ext);
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
    res.writeHead(200, headers); res.end(await readFile(file));
  } catch { fail(404, 'Not found'); }
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/public/config') return send(res, 200, { signupEnabled: getPlatform().allowSignup, announcement: getPlatform().announcement });
    if (url.pathname === '/api/site-key' && process.env.DEMO !== '0') return send(res, 200, { key: db.prepare('SELECT site_key FROM sites ORDER BY id LIMIT 1').get()?.site_key }); // demo page only
    if (url.pathname.startsWith('/api/widget/')) return await widgetRoute(req, res, url);
    if (url.pathname.startsWith('/api/')) return await apiRoute(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return url_isApi(req) ? send(res, e.code, { error: e.message }) : (res.writeHead(e.code, { 'Content-Type': 'text/plain' }), res.end(e.message));
    console.error(e); send(res, 500, { error: 'Internal error' });
  }
});
const url_isApi = req => (req.url || '').startsWith('/api/');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => console.log(`Chatly running → http://localhost:${port}  (dashboard: /app, demo site: /)`));
}
