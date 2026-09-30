import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, seed, getSettings, setSettings, hashPassword, checkPassword } from './db.js';
import { matchRule, parseRule, HUMAN_PHRASE } from './bot.js';

seed();
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

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 200_000) fail(413, 'Payload too large'); chunks.push(c); }
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
const ipOf = req => req.socket.remoteAddress || '';

// ---------- realtime hub ----------
const agentStreams = new Set();           // { res, agentId }
const visitorStreams = new Map();         // vid -> Set(res)
const offlineTimers = new Map();

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
}
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const toAgents = (event, data) => { const f = frame(event, data); for (const s of agentStreams) s.res.write(f); };
const toVisitor = (vid, event, data) => { const f = frame(event, data); for (const r of visitorStreams.get(vid) || []) r.write(f); };
setInterval(() => {
  for (const s of agentStreams) s.res.write(': ping\n\n');
  for (const set of visitorStreams.values()) for (const r of set) r.write(': ping\n\n');
}, 25_000).unref();
const agentsOnline = () => new Set([...agentStreams].map(s => s.agentId)).size;
const isOnline = vid => (visitorStreams.get(vid)?.size || 0) > 0;

// ---------- domain ----------
const visitorOut = v => v && ({ id: v.id, name: v.name, email: v.email, page: v.page, ua: v.ua, visits: v.visits, created: v.created, last_seen: v.last_seen, online: isOnline(v.id) });
function convOut(c) {
  const v = db.prepare('SELECT * FROM visitors WHERE id=?').get(c.visitor_id);
  const a = c.assignee_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(c.assignee_id) : null;
  return { id: c.id, status: c.status, assignee_id: c.assignee_id, assignee_name: a?.name || null, bot_active: !!c.bot_active,
    needs_human: !!c.needs_human, unread: c.unread, last_body: c.last_body, created: c.created, updated: c.updated, visitor: visitorOut(v) };
}
const msgOut = m => ({ id: m.id, conv_id: m.conv_id, sender: m.sender, sender_name: m.sender_name, body: m.body, buttons: m.buttons ? JSON.parse(m.buttons) : [], created: m.created });
const getConv = id => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);

function addMessage(conv, sender, body, { senderId = null, senderName = null, buttons = null } = {}) {
  const t = now();
  const info = db.prepare('INSERT INTO messages(conv_id,sender,sender_id,sender_name,body,buttons,created) VALUES(?,?,?,?,?,?,?)')
    .run(conv.id, sender, senderId, senderName, body, buttons?.length ? JSON.stringify(buttons) : null, t);
  if (sender !== 'note') {
    db.prepare('UPDATE conversations SET last_body=?, updated=?, unread=unread+? WHERE id=?').run(body.slice(0, 140), t, sender === 'visitor' ? 1 : 0, conv.id);
  }
  const m = msgOut(db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid));
  const c = convOut(getConv(conv.id));
  toAgents('message', { conv: c, message: m });
  if (sender !== 'note') toVisitor(conv.visitor_id, 'message', m);
  return m;
}

function openConversation(vid) {
  let c = db.prepare("SELECT * FROM conversations WHERE visitor_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(vid);
  if (c) return c;
  const t = now(); const s = getSettings();
  const id = db.prepare('INSERT INTO conversations(visitor_id,status,bot_active,created,updated) VALUES(?,?,?,?,?)').run(vid, 'open', s.botEnabled ? 1 : 0, t, t).lastInsertRowid;
  c = getConv(id);
  toAgents('conversation', convOut(c));
  return c;
}

function handoff(conv) {
  const s = getSettings(); const online = agentsOnline() > 0;
  db.prepare('UPDATE conversations SET bot_active=0, needs_human=1 WHERE id=?').run(conv.id);
  const fresh = getConv(conv.id);
  addMessage(fresh, 'bot', online ? s.handoffMessage : s.offlineMessage, { senderName: 'Bot' });
  toVisitor(conv.visitor_id, 'handoff', { online });
  toAgents('conversation', convOut(getConv(conv.id)));
}

function botRespond(convId, text) {
  const conv = getConv(convId);
  if (!conv || !conv.bot_active) return;
  const s = getSettings();
  const reply = (body, buttons) => addMessage(getConv(convId), 'bot', body, { senderName: 'Bot', buttons });
  toVisitor(conv.visitor_id, 'typing', { who: 'bot' });
  setTimeout(() => {
    const cur = getConv(convId);
    if (!cur || !cur.bot_active) return;
    if (text.toLowerCase() === HUMAN_PHRASE) return handoff(cur);
    const rule = matchRule(text);
    if (rule) { reply(rule.reply, rule.buttons); if (rule.handoff) handoff(getConv(convId)); }
    else reply(s.fallbackMessage, ['Talk to a human']);
  }, 700);
}

function upsertVisitor(vid, page, req) {
  const t = now(); const ua = str(req.headers['user-agent'], 300);
  const ex = db.prepare('SELECT * FROM visitors WHERE id=?').get(vid);
  if (!ex) db.prepare('INSERT INTO visitors(id,created,last_seen,page,ua) VALUES(?,?,?,?,?)').run(vid, t, t, page, ua);
  else db.prepare('UPDATE visitors SET last_seen=?, page=COALESCE(NULLIF(?,\'\'),page), ua=?, visits=visits+? WHERE id=?')
    .run(t, page, ua, t - ex.last_seen > 30 * 60_000 ? 1 : 0, vid);
  return db.prepare('SELECT * FROM visitors WHERE id=?').get(vid);
}

// ---------- widget API (public) ----------
function corsFor(req, res) {
  const allowed = getSettings().allowedOrigins.split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  const ok = allowed.includes('*') || (origin && allowed.includes(origin));
  res.setHeader('Vary', 'Origin');
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  return ok;
}
const VID = /^[A-Za-z0-9_-]{8,64}$/;
function widgetCtx(key, vid) {
  if (key !== getSettings().siteKey) fail(403, 'Invalid site key');
  if (!VID.test(vid || '')) fail(400, 'Invalid visitor id');
}
const publicSettings = s => ({ title: s.title, subtitle: s.subtitle, color: s.color, position: s.position, greeting: s.greeting,
  askEmail: s.askEmail, proactiveEnabled: s.proactiveEnabled, proactiveDelay: s.proactiveDelay, proactiveMessage: s.proactiveMessage, brandName: s.brandName });

async function widgetRoute(req, res, url) {
  const route = url.pathname.slice('/api/widget/'.length);
  if (req.method === 'OPTIONS') { corsFor(req, res); res.writeHead(204); return res.end(); }
  if (!corsFor(req, res)) fail(403, 'Origin not allowed');

  if (route === 'events' && req.method === 'GET') {
    const vid = url.searchParams.get('vid'); widgetCtx(url.searchParams.get('key'), vid);
    upsertVisitor(vid, '', req);
    sse(res);
    if (!visitorStreams.has(vid)) visitorStreams.set(vid, new Set());
    visitorStreams.get(vid).add(res);
    clearTimeout(offlineTimers.get(vid));
    toAgents('presence', { visitor_id: vid, online: true, visitor: visitorOut(db.prepare('SELECT * FROM visitors WHERE id=?').get(vid)) });
    res.write(frame('ready', { agentsOnline: agentsOnline() > 0 }));
    req.on('close', () => {
      const set = visitorStreams.get(vid); set?.delete(res);
      if (set && !set.size) {
        visitorStreams.delete(vid);
        offlineTimers.set(vid, setTimeout(() => toAgents('presence', { visitor_id: vid, online: false }), 4000));
      }
    });
    return;
  }
  if (req.method !== 'POST') fail(404, 'Not found');
  const b = await readBody(req);
  widgetCtx(b.key, b.vid);
  limit('w:' + ipOf(req), 120, 60_000);

  if (route === 'init') {
    const v = upsertVisitor(b.vid, str(b.page, 500), req);
    const s = getSettings();
    const conv = db.prepare("SELECT * FROM conversations WHERE visitor_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(b.vid);
    const messages = conv ? db.prepare('SELECT * FROM messages WHERE conv_id=? AND sender!=\'note\' ORDER BY id').all(conv.id).map(msgOut) : [];
    toAgents('presence', { visitor_id: v.id, online: true, visitor: visitorOut(v) });
    return send(res, 200, { settings: publicSettings(s), visitor: { name: v.name, email: v.email }, messages, agentsOnline: agentsOnline() > 0 });
  }
  if (route === 'ping') {
    const v = upsertVisitor(b.vid, str(b.page, 500), req);
    toAgents('presence', { visitor_id: v.id, online: isOnline(v.id), visitor: visitorOut(v) });
    return send(res, 200, { ok: true });
  }
  if (route === 'message') {
    limit('wm:' + b.vid, 30, 60_000);
    const body = str(b.body, 2000); if (!body) fail(400, 'Empty message');
    upsertVisitor(b.vid, str(b.page, 500), req);
    const conv = openConversation(b.vid);
    const fresh = db.prepare('SELECT COUNT(*) n FROM messages WHERE conv_id=?').get(conv.id).n === 0;
    const m = addMessage(conv, 'visitor', body);
    if (fresh && getSettings().botEnabled === false) { /* no greeting persisted when bot is off */ }
    botRespond(conv.id, body);
    return send(res, 200, { message: m });
  }
  if (route === 'typing') { toAgents('typing', { visitor_id: b.vid, conv_id: null }); return send(res, 200, { ok: true }); }
  if (route === 'identify') {
    const name = str(b.name, 100), email = str(b.email, 200).toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Invalid email');
    upsertVisitor(b.vid, '', req);
    db.prepare('UPDATE visitors SET name=COALESCE(NULLIF(?,\'\'),name), email=COALESCE(NULLIF(?,\'\'),email) WHERE id=?').run(name, email, b.vid);
    const v = db.prepare('SELECT * FROM visitors WHERE id=?').get(b.vid);
    const conv = db.prepare("SELECT * FROM conversations WHERE visitor_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(b.vid);
    if (conv && email) addMessage(conv, 'system', `Visitor shared their email: ${email}`);
    toAgents('presence', { visitor_id: v.id, online: isOnline(v.id), visitor: visitorOut(v) });
    return send(res, 200, { ok: true });
  }
  fail(404, 'Not found');
}

// ---------- agent API ----------
function authAgent(req) {
  const tok = cookies(req).sid; if (!tok) return null;
  return db.prepare('SELECT a.id, a.name, a.email, a.role FROM sessions s JOIN agents a ON a.id=s.agent_id WHERE s.token=?').get(tok) || null;
}
const agentOut = a => ({ id: a.id, name: a.name, email: a.email, role: a.role });

async function apiRoute(req, res, url) {
  const p = url.pathname, m = req.method;
  let x;

  if (p === '/api/auth/login' && m === 'POST') {
    limit('login:' + ipOf(req), 10, 60_000);
    const b = await readBody(req);
    const a = db.prepare('SELECT * FROM agents WHERE email=?').get(str(b.email, 200).toLowerCase());
    if (!a || !checkPassword(String(b.password || ''), a.pass)) fail(401, 'Invalid email or password');
    const tok = randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions(token,agent_id,created) VALUES(?,?,?)').run(tok, a.id, now());
    res.setHeader('Set-Cookie', `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`);
    return send(res, 200, { agent: agentOut(a) });
  }
  const me = authAgent(req);
  if (p === '/api/auth/logout' && m === 'POST') {
    const tok = cookies(req).sid; if (tok) db.prepare('DELETE FROM sessions WHERE token=?').run(tok);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    return send(res, 200, {});
  }
  if (!me) fail(401, 'Not authenticated');
  const admin = () => { if (me.role !== 'admin') fail(403, 'Admins only'); };
  const bodyId = v => { const n = Number(v); if (!Number.isInteger(n)) fail(400, 'Bad id'); return n; };

  if (p === '/api/me') return send(res, 200, { agent: agentOut(me), siteKey: getSettings().siteKey });

  if (p === '/api/events' && m === 'GET') {
    sse(res);
    const entry = { res, agentId: me.id };
    const wasOnline = agentsOnline() > 0;
    agentStreams.add(entry);
    res.write(frame('ready', {}));
    if (!wasOnline) toVisitorsAll('agents', { online: true });
    req.on('close', () => { agentStreams.delete(entry); if (agentsOnline() === 0) toVisitorsAll('agents', { online: false }); });
    return;
  }

  if (p === '/api/stats' && m === 'GET') {
    const one = (q, ...a) => db.prepare(q).get(...a).n;
    const day = new Date(); day.setHours(0, 0, 0, 0);
    return send(res, 200, {
      open: one("SELECT COUNT(*) n FROM conversations WHERE status='open'"),
      unassigned: one("SELECT COUNT(*) n FROM conversations WHERE status='open' AND assignee_id IS NULL"),
      needsHuman: one("SELECT COUNT(*) n FROM conversations WHERE status='open' AND needs_human=1"),
      today: one('SELECT COUNT(*) n FROM conversations WHERE created>=?', day.getTime()),
      messagesToday: one('SELECT COUNT(*) n FROM messages WHERE created>=?', day.getTime()),
      visitorsOnline: visitorStreams.size, agentsOnline: agentsOnline(),
      resolved: one("SELECT COUNT(*) n FROM conversations WHERE status='closed'"),
    });
  }

  if (p === '/api/conversations' && m === 'GET') {
    const st = url.searchParams.get('status'), f = url.searchParams.get('filter'), q = str(url.searchParams.get('q') || '', 100);
    let sql = 'SELECT c.* FROM conversations c JOIN visitors v ON v.id=c.visitor_id WHERE 1=1'; const args = [];
    if (st === 'open' || st === 'closed') { sql += ' AND c.status=?'; args.push(st); }
    if (f === 'mine') { sql += ' AND c.assignee_id=?'; args.push(me.id); }
    if (f === 'unassigned') sql += ' AND c.assignee_id IS NULL';
    if (f === 'human') sql += ' AND c.needs_human=1';
    if (q) { sql += ' AND (v.name LIKE ? OR v.email LIKE ? OR c.last_body LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY c.needs_human DESC, c.updated DESC LIMIT 200';
    return send(res, 200, { conversations: db.prepare(sql).all(...args).map(convOut) });
  }
  if ((x = p.match(/^\/api\/conversations\/(\d+)$/)) && m === 'GET') {
    const c = getConv(+x[1]) || fail(404, 'Not found');
    return send(res, 200, { conversation: convOut(c), messages: db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id').all(c.id).map(msgOut) });
  }
  if ((x = p.match(/^\/api\/conversations\/(\d+)\/(messages|note|read|typing|status|assign)$/)) && m === 'POST') {
    const c = getConv(+x[1]) || fail(404, 'Not found');
    const b = await readBody(req);
    const refresh = () => toAgents('conversation', convOut(getConv(c.id)));
    switch (x[2]) {
      case 'messages': {
        const body = str(b.body, 4000); if (!body) fail(400, 'Empty message');
        db.prepare("UPDATE conversations SET bot_active=0, needs_human=0, unread=0, status='open', assignee_id=COALESCE(assignee_id,?) WHERE id=?").run(me.id, c.id);
        return send(res, 200, { message: addMessage(getConv(c.id), 'agent', body, { senderId: me.id, senderName: me.name }) });
      }
      case 'note': {
        const body = str(b.body, 4000); if (!body) fail(400, 'Empty note');
        return send(res, 200, { message: addMessage(c, 'note', body, { senderId: me.id, senderName: me.name }) });
      }
      case 'read': db.prepare('UPDATE conversations SET unread=0 WHERE id=?').run(c.id); refresh(); return send(res, 200, {});
      case 'typing': toVisitor(c.visitor_id, 'typing', { who: 'agent', name: me.name }); return send(res, 200, {});
      case 'status': {
        const s = b.status === 'closed' ? 'closed' : 'open';
        db.prepare('UPDATE conversations SET status=?, needs_human=0 WHERE id=?').run(s, c.id);
        if (s === 'closed') addMessage(getConv(c.id), 'system', `${me.name} closed this conversation`);
        refresh(); return send(res, 200, {});
      }
      case 'assign': {
        const aid = b.agent_id == null ? null : bodyId(b.agent_id);
        if (aid && !db.prepare('SELECT 1 FROM agents WHERE id=?').get(aid)) fail(404, 'No such agent');
        db.prepare('UPDATE conversations SET assignee_id=? WHERE id=?').run(aid, c.id);
        refresh(); return send(res, 200, {});
      }
    }
  }
  if ((x = p.match(/^\/api\/conversations\/(\d+)$/)) && m === 'DELETE') {
    admin(); db.prepare('DELETE FROM conversations WHERE id=?').run(+x[1]);
    toAgents('deleted', { id: +x[1] }); return send(res, 200, {});
  }

  if (p === '/api/visitors' && m === 'GET') {
    const online = [...visitorStreams.keys()];
    const rows = online.length ? db.prepare(`SELECT * FROM visitors WHERE id IN (${online.map(() => '?').join(',')}) ORDER BY last_seen DESC`).all(...online) : [];
    return send(res, 200, { visitors: rows.map(visitorOut) });
  }

  if (p === '/api/canned') {
    if (m === 'GET') return send(res, 200, { canned: db.prepare('SELECT * FROM canned ORDER BY shortcut').all() });
    if (m === 'POST') {
      const b = await readBody(req); const sc = str(b.shortcut, 30).toLowerCase().replace(/[^a-z0-9_-]/g, ''), text = str(b.text, 2000);
      if (!sc || !text) fail(400, 'Shortcut and text required');
      try { db.prepare('INSERT INTO canned(shortcut,text) VALUES(?,?)').run(sc, text); } catch { fail(409, 'Shortcut already exists'); }
      return send(res, 200, {});
    }
  }
  if ((x = p.match(/^\/api\/canned\/(\d+)$/)) && m === 'DELETE') { db.prepare('DELETE FROM canned WHERE id=?').run(+x[1]); return send(res, 200, {}); }

  if (p === '/api/rules' && m === 'GET') return send(res, 200, { rules: db.prepare('SELECT * FROM rules ORDER BY position, id').all().map(parseRule) });
  if (p === '/api/rules' && m === 'POST') {
    admin(); const b = await readBody(req);
    const r = ruleFields(b);
    const pos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 n FROM rules').get().n;
    const id = db.prepare('INSERT INTO rules(name,keywords,reply,buttons,handoff,enabled,position) VALUES(?,?,?,?,?,?,?)').run(r.name, r.keywords, r.reply, r.buttons, r.handoff, r.enabled, pos).lastInsertRowid;
    return send(res, 200, { id });
  }
  if ((x = p.match(/^\/api\/rules\/(\d+)$/))) {
    admin();
    if (m === 'PUT') {
      const r = ruleFields(await readBody(req));
      db.prepare('UPDATE rules SET name=?,keywords=?,reply=?,buttons=?,handoff=?,enabled=? WHERE id=?').run(r.name, r.keywords, r.reply, r.buttons, r.handoff, r.enabled, +x[1]);
      return send(res, 200, {});
    }
    if (m === 'DELETE') { db.prepare('DELETE FROM rules WHERE id=?').run(+x[1]); return send(res, 200, {}); }
  }
  if (p === '/api/bot/test' && m === 'POST') {
    const b = await readBody(req); const r = matchRule(str(b.text, 500));
    return send(res, 200, { rule: r });
  }

  if (p === '/api/settings') {
    if (m === 'GET') return send(res, 200, { settings: getSettings() });
    if (m === 'PUT') {
      admin(); const b = await readBody(req); delete b.siteKey;
      if (b.color && !/^#[0-9a-fA-F]{6}$/.test(b.color)) fail(400, 'Color must be a hex value like #4f46e5');
      if (b.position && !['left', 'right'].includes(b.position)) fail(400, 'Bad position');
      if ('proactiveDelay' in b) b.proactiveDelay = Math.max(0, Math.min(600, Number(b.proactiveDelay) || 0));
      for (const k of ['askEmail', 'botEnabled', 'proactiveEnabled']) if (k in b) b[k] = !!b[k];
      for (const k of ['brandName', 'title', 'subtitle', 'greeting', 'offlineMessage', 'handoffMessage', 'fallbackMessage', 'proactiveMessage', 'allowedOrigins']) if (k in b) b[k] = str(b[k], 500);
      setSettings(b); return send(res, 200, { settings: getSettings() });
    }
  }

  if (p === '/api/agents') {
    if (m === 'GET') return send(res, 200, { agents: db.prepare('SELECT id,name,email,role FROM agents ORDER BY id').all().map(a => ({ ...a, online: [...agentStreams].some(s => s.agentId === a.id) })) });
    if (m === 'POST') {
      admin(); const b = await readBody(req);
      const name = str(b.name, 80), email = str(b.email, 200).toLowerCase(), pw = String(b.password || '');
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Valid name and email required');
      if (pw.length < 6) fail(400, 'Password must be at least 6 characters');
      try { db.prepare('INSERT INTO agents(name,email,pass,role,created) VALUES(?,?,?,?,?)').run(name, email, hashPassword(pw), b.role === 'admin' ? 'admin' : 'agent', now()); }
      catch { fail(409, 'Email already in use'); }
      return send(res, 200, {});
    }
  }
  if ((x = p.match(/^\/api\/agents\/(\d+)$/)) && m === 'DELETE') {
    admin(); if (+x[1] === me.id) fail(400, "You can't remove yourself");
    db.prepare('DELETE FROM agents WHERE id=?').run(+x[1]); return send(res, 200, {});
  }
  if (p === '/api/me/password' && m === 'POST') {
    const b = await readBody(req); const a = db.prepare('SELECT * FROM agents WHERE id=?').get(me.id);
    if (!checkPassword(String(b.current || ''), a.pass)) fail(403, 'Current password is wrong');
    if (String(b.password || '').length < 6) fail(400, 'Password must be at least 6 characters');
    db.prepare('UPDATE agents SET pass=? WHERE id=?').run(hashPassword(b.password), me.id); return send(res, 200, {});
  }
  fail(404, 'Not found');
}
function toVisitorsAll(event, data) { const f = frame(event, data); for (const set of visitorStreams.values()) for (const r of set) r.write(f); }
function ruleFields(b) {
  const name = str(b.name, 80), keywords = str(b.keywords, 500), reply = str(b.reply, 2000);
  if (!name || !keywords || !reply) fail(400, 'Name, keywords and reply are required');
  const buttons = (Array.isArray(b.buttons) ? b.buttons : []).map(x => str(x, 40)).filter(Boolean).slice(0, 5);
  return { name, keywords, reply, buttons: JSON.stringify(buttons), handoff: b.handoff ? 1 : 0, enabled: b.enabled === false ? 0 : 1 };
}

// ---------- static + server ----------
async function serveStatic(req, res, url) {
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
    if (url.pathname === '/api/site-key') return send(res, 200, { key: getSettings().siteKey }); // demo page only
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
  server.listen(port, () => console.log(`Chatly running → http://localhost:${port}  (dashboard: /app, demo site: /)`));
}
