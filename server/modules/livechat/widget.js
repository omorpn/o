/** Public widget API (/api/widget/*): CORS, visitor identity, messages, uploads, ratings, realtime stream. */
import { db, now, getSettings } from '../../core/db.js';
import { send, fail, str, limit, ipOf, EMAIL } from '../../core/http.js';
import { emit } from '../../core/events.js';
import { isEnabled } from '../../core/modules.js';
import { sse, frame, toAgents, visitorStreams, isOnline } from '../../core/realtime.js';
import * as fraud from '../fraud/engine.js';
import { widgetTriggers, triggerMessage } from '../triggers/index.js';
import { automationOn, botRespond } from './automation.js';
import { addMessage, openConversation, upsertVisitor, saveUpload, emitPresence, getConv, msgOut, teamAvailable, identifyVisitor } from './service.js';

/** Normalises what people type into "Allowed origins": scheme optional, trailing slash/path ignored, www. optional. */
const hostOf = v => String(v).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
export function originAllowed(allowedList, origin) {
  if (allowedList.includes('*')) return true;
  if (!origin || origin === 'null') return false;
  const host = hostOf(origin);
  return allowedList.some(a => { const h = hostOf(a); return h === host || (h.startsWith('*.') && (host === h.slice(2) || host.endsWith(h.slice(1)))); });
}
function corsFor(req, res, siteId) {
  const allowed = siteId ? getSettings(siteId).allowedOrigins.split(',').map(s => s.trim()).filter(Boolean) : ['*'];
  const origin = req.headers.origin, ok = originAllowed(allowed, origin);
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
const publicSettings = (site, s) => ({ gradient: s.gradient, launcherStyle: s.launcherStyle, launcherLabel: s.launcherLabel, avatarUrl: s.avatarUrl, theme: s.theme, prechatForm: s.prechatForm, showBranding: s.showBranding,
  triggers: isEnabled(site.workspace_id, 'triggers') ? widgetTriggers(site.id) : [], ratingEnabled: s.ratingEnabled,
  title: s.title, subtitle: s.subtitle, color: s.color, position: s.position, greeting: s.greeting, askEmail: s.askEmail, proactiveEnabled: s.proactiveEnabled, proactiveDelay: s.proactiveDelay, proactiveMessage: s.proactiveMessage, brandName: s.brandName });

const offlineTimers = new Map();

async function widgetHandler(c) {
  const { req, res, url } = c, route = c.params.route;
  if (req.method === 'OPTIONS') { corsFor(req, res, null); res.writeHead(204); return res.end(); }
  res.setHeader('Access-Control-Allow-Origin', '*'); // lets the widget read error messages; corsFor narrows it for allowed requests
  let site, vid, b = {};
  if (route === 'events' && req.method === 'GET') { site = siteByKey(url.searchParams.get('key')); vid = url.searchParams.get('vid'); }
  else if (req.method === 'POST') { b = await c.body(route === 'upload' ? 4_500_000 : 200_000); site = siteByKey(b.key); vid = b.vid; }
  else fail(404, 'Not found');
  if (!corsFor(req, res, site.id)) {
    const o = String(req.headers.origin || 'unknown origin').slice(0, 200);
    db.prepare('UPDATE sites SET last_error=?, last_error_at=? WHERE id=?').run(`Blocked on ${o}: not in this website's Allowed origins`, now(), site.id);
    res.setHeader('Access-Control-Allow-Origin', '*');
    fail(403, `This website (${o}) is not in the Allowed origins for this Chatly site. Add it under Settings → Widget → Allowed origins.`);
  }
  if (!VID.test(vid || '')) fail(400, 'Invalid visitor id');
  const vkey = `${site.id}:${vid}`, ws = site.workspace_id, ip = ipOf(req);
  if (fraud.visitorBlocked(site, vkey, ip) && route !== 'message') fail(403, 'This chat is currently unavailable.');

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
  limit('w:' + ip, 3000, 60_000);

  if (route === 'init') {
    const v = upsertVisitor(site, vkey, str(b.page, 500), req);
    db.prepare('UPDATE sites SET last_seen_at=?, last_origin=? WHERE id=?').run(now(), str(req.headers.origin || '', 200) || str(b.page, 200).replace(/^(https?:\/\/[^/]+).*/, '$1') || null, site.id);
    const conv = db.prepare("SELECT * FROM conversations WHERE visitor_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(vkey);
    const messages = conv ? db.prepare('SELECT * FROM messages WHERE conv_id=? AND sender!=\'note\' ORDER BY id').all(conv.id).map(msgOut) : [];
    emitPresence(v, true);
    return { settings: publicSettings(site, getSettings(site.id)), visitor: { name: v.name, email: v.email }, messages, agentsOnline: teamAvailable(site.id) };
  }
  if (route === 'ping') { emitPresence(upsertVisitor(site, vkey, str(b.page, 500), req), isOnline(vkey)); return { ok: true }; }
  if (route === 'message') {
    limit('wm:' + vkey, 30, 60_000);
    const body = str(b.body, 2000); if (!body) fail(400, 'Empty message');
    // Spam & abuse screening. Blocked messages are silently dropped so spammers don't learn what triggers the filter.
    const shadow = () => send(res, 200, { message: { id: -now(), conv_id: null, sender: 'visitor', sender_name: null, body, buttons: [], attachment: null, created: now() } });
    if (fraud.visitorBlocked(site, vkey, ip)) return shadow();
    const verdict = fraud.record({ kind: 'visitor_message', workspaceId: ws, siteId: site.id, visitorId: vkey, ip, summary: body,
      signals: fraud.scoreVisitorMessage({ site, vkey, ip, ua: req.headers['user-agent'], text: body, spamFilter: isEnabled(ws, 'spam') ? getSettings(site.id).spamFilter : 'normal' }) });
    if (verdict.blocked) {
      if (verdict.score >= 90) fraud.addBlock({ workspaceId: ws, type: 'visitor', value: vkey, reason: `Auto-blocked: spam score ${verdict.score}`, ttlMs: 24 * 3600_000 });
      return shadow();
    }
    upsertVisitor(site, vkey, str(b.page, 500), req);
    const conv = openConversation(site, vkey, { botEnabled: automationOn(ws) });
    if (b.trigger && isEnabled(ws, 'triggers') && db.prepare('SELECT COUNT(*) n FROM messages WHERE conv_id=?').get(conv.id).n === 0) {
      const t = triggerMessage(b.trigger, site.id); if (t) addMessage(conv, 'bot', t, { senderName: 'Bot' });
    }
    if (verdict.score >= fraud.fraudSettings().reviewThreshold) db.prepare('UPDATE conversations SET spam_score=MAX(COALESCE(spam_score,0),?) WHERE id=?').run(verdict.score, conv.id);
    const m = addMessage(conv, 'visitor', body);
    botRespond(conv.id, body);
    return { message: m };
  }
  if (route === 'upload') {
    limit('wu:' + vkey, 10, 60_000);
    upsertVisitor(site, vkey, '', req);
    const att = await saveUpload(b), conv = openConversation(site, vkey, { botEnabled: automationOn(ws) });
    return { message: addMessage(conv, 'visitor', `📎 ${att.name}`, { attachment: att }) };
  }
  if (route === 'rate') {
    const rating = Math.round(Number(b.rating));
    if (!(rating >= 1 && rating <= 5)) fail(400, 'Rating must be 1-5');
    const conv = db.prepare("SELECT * FROM conversations WHERE visitor_id=? AND status='closed' AND rating IS NULL ORDER BY id DESC LIMIT 1").get(vkey);
    if (!conv) fail(404, 'Nothing to rate');
    const comment = str(b.comment, 500);
    db.prepare('UPDATE conversations SET rating=?, rating_comment=? WHERE id=?').run(rating, comment, conv.id);
    addMessage(getConv(conv.id), 'system', `Visitor rated this conversation ${rating}/5${comment ? ': ' + comment : ''}`);
    emit('conversation.rated', { conv: getConv(conv.id), rating, comment });
    return { ok: true };
  }
  if (route === 'typing') { toAgents(ws, site.id, 'typing', { visitor_id: vkey }); return { ok: true }; }
  if (route === 'identify') {
    const name = str(b.name, 100), email = str(b.email, 200).toLowerCase();
    if (email && !EMAIL.test(email)) fail(400, 'Invalid email');
    upsertVisitor(site, vkey, '', req);
    identifyVisitor(vkey, { name, email });
    const conv = db.prepare("SELECT * FROM conversations WHERE visitor_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(vkey);
    if (conv && email) addMessage(conv, 'system', `Visitor shared their email: ${email}`);
    return { ok: true };
  }
  fail(404, 'Not found');
}

export const widgetRoutes = [{ method: ['GET', 'POST', 'OPTIONS'], path: '/api/widget/:route', auth: 'public', handler: widgetHandler }];
