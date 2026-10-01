/**
 * Social channels: WhatsApp (Cloud API), Facebook Messenger and Instagram Direct in the same inbox as website chat.
 * Each business connects its own Meta app: we store the access token and app secret (encrypted with DATA_KEY), give
 * it a private webhook URL + verify token, and from then on incoming messages become conversations (bot, flows, AI,
 * routing and notifications all apply) and agent/bot replies are delivered back through the Graph API, with
 * delivery receipts. WhatsApp's 24-hour customer-service window is enforced; outside it agents send a template.
 */
import { randomBytes } from 'node:crypto';
import { db, now } from '../../core/db.js';
import { fail, str, limit } from '../../core/http.js';
import { on } from '../../core/events.js';
import { defineModule, isEnabled } from '../../core/modules.js';
import { toAgents } from '../../core/realtime.js';
import { seal, unseal, mask } from '../../core/secrets.js';
import * as fraud from '../fraud/engine.js';
import { automationOn, botRespond } from '../livechat/automation.js';
import { loadConv } from '../livechat/index.js';
import { siteRow, getConv, getVisitor, openConversation, addMessage, saveUpload, emitPresence, emitConv } from '../livechat/service.js';
import { graph, validSignature, parseWebhook, sendMessage, sendTemplate, fetchMedia } from './meta.js';

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type TEXT NOT NULL, name TEXT NOT NULL, account_id TEXT NOT NULL, page_id TEXT, display TEXT, token TEXT NOT NULL, app_secret TEXT NOT NULL,
  verify_token TEXT NOT NULL, webhook_token TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, last_inbound INTEGER, last_error TEXT, created INTEGER NOT NULL,
  UNIQUE(type, account_id));
`);
export const TYPES = { whatsapp: { label: 'WhatsApp', prefix: 'wa', icon: '🟢' }, messenger: { label: 'Messenger', prefix: 'fb', icon: '🔵' }, instagram: { label: 'Instagram', prefix: 'ig', icon: '🟣' } };
const WINDOW_MS = 24 * 3600_000;
const rnd = n => randomBytes(n).toString('hex');
const withSecrets = c => c && { ...c, token: unseal(c.token), app_secret: unseal(c.app_secret) };
const chOut = (c, origin) => ({ id: c.id, type: c.type, label: TYPES[c.type].label, name: c.name, site_id: c.site_id, account_id: c.account_id, page_id: c.page_id, display: c.display, enabled: !!c.enabled,
  token: mask(unseal(c.token)), app_secret: mask(unseal(c.app_secret)), verify_token: c.verify_token, webhook_url: `${origin}/api/channels/webhook/${c.webhook_token}`, last_inbound: c.last_inbound, last_error: c.last_error });
const origin = c => (process.env.PUBLIC_URL || `${c.req.headers['x-forwarded-proto'] || 'http'}://${c.req.headers['x-forwarded-host'] || c.req.headers.host}`).replace(/\/$/, '');
const setError = (id, e) => db.prepare('UPDATE channels SET last_error=? WHERE id=?').run(e ? String(e).slice(0, 300) : null, id);
const skipOutbound = new Set(); // message ids already delivered by another path (templates)

/** Checks credentials with Meta and returns a display label (phone number or Page/IG name). */
async function probe(type, accountId, token) {
  if (type === 'whatsapp') { const d = await graph(`/${accountId}?fields=display_phone_number,verified_name`, token); return [d.display_phone_number, d.verified_name].filter(Boolean).join(' · ') || accountId; }
  const d = await graph(`/${accountId}?fields=name,username`, token); return d.username ? '@' + d.username : d.name || accountId;
}

// ---------- inbound ----------
async function receive(ch, m) {
  const ws = ch.workspace_id, site = siteRow(ch.site_id); if (!site || !m.from) return;
  if (db.prepare('SELECT 1 FROM messages WHERE external_id=?').get(m.id)) return; // Meta retries deliveries
  const vkey = `${site.id}:${TYPES[ch.type].prefix}_${m.from}`;
  if (fraud.isBlocked('visitor', vkey, ws) || (ch.type === 'whatsapp' && fraud.isBlocked('phone', m.from, ws))) return;
  try { limit('chin:' + vkey, 60, 60_000); } catch { return; }
  let v = getVisitor(vkey), t = now();
  if (!v) {
    let name = m.name;
    if (!name && ch.type !== 'whatsapp') { try { const p = await graph(`/${m.from}?fields=name,username`, ch.token); name = p.name || (p.username && '@' + p.username); } catch { /* profile not available */ } }
    db.prepare('INSERT INTO visitors(id,site_id,name,phone,channel,created,last_seen,ua) VALUES(?,?,?,?,?,?,?,?)').run(vkey, site.id, name || null, ch.type === 'whatsapp' ? '+' + m.from : null, ch.type, t, t, TYPES[ch.type].label);
  } else db.prepare('UPDATE visitors SET last_seen=?, name=COALESCE(name,?) WHERE id=?').run(t, m.name, vkey);
  v = getVisitor(vkey); emitPresence(v, false);
  const conv = openConversation(site, vkey, { botEnabled: automationOn(ws), channel: ch.type });
  db.prepare('UPDATE conversations SET last_inbound=?, channel_id=? WHERE id=?').run(t, ch.id, conv.id);
  db.prepare('UPDATE channels SET last_inbound=?, last_error=NULL WHERE id=?').run(t, ch.id);
  let attachment = null;
  if (m.media) { try { attachment = await saveUpload(await fetchMedia(ch, m.media)); } catch { /* unsupported type or too large: keep the text */ } }
  const text = m.text || (attachment ? `📎 ${attachment.name}` : m.media ? `[${m.kind} message]` : `[${m.kind || 'unsupported'} message]`);
  const msg = addMessage(getConv(conv.id), 'visitor', text.slice(0, 4000), { attachment });
  db.prepare('UPDATE messages SET external_id=? WHERE id=?').run(m.id, msg.id);
  if (m.text) botRespond(conv.id, m.text);
}

// ---------- outbound ----------
async function deliver(conv, message) {
  const ch = withSecrets(db.prepare('SELECT * FROM channels WHERE id=?').get(conv.channel_id));
  const setDelivery = (delivery, extId) => { db.prepare('UPDATE messages SET delivery=?, external_id=COALESCE(?,external_id) WHERE id=?').run(delivery, extId || null, message.id); toAgents(conv.workspace_id, conv.site_id, 'message_status', { conv_id: conv.id, id: message.id, delivery }, conv); };
  const failNote = why => { setDelivery('failed'); addMessage(getConv(conv.id), 'note', `⚠️ Not delivered to ${TYPES[conv.channel].label}: ${why}`, { senderName: 'System' }); };
  if (!ch || !ch.enabled) return failNote('the channel is disconnected');
  if (ch.type === 'whatsapp' && now() - (getConv(conv.id).last_inbound || 0) > WINDOW_MS) return failNote("the customer hasn't written in the last 24 hours, so WhatsApp only allows an approved template message. Use “Send template”.");
  const to = conv.visitor_id.split(':')[1].replace(/^(wa|fb|ig)_/, '');
  const att = message.attachment, base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  try {
    const media = att && base ? { link: base + att.url, type: att.type, name: att.name } : null;
    const text = att && !base ? `${message.body}` : att ? '' : message.body;
    const id = await sendMessage(ch, to, { text, buttons: message.buttons || [], media });
    setDelivery('sent', id); setError(ch.id, null);
  } catch (e) { setError(ch.id, e.message); failNote(e.message); }
}

export default defineModule({
  key: 'channels', name: 'WhatsApp, Messenger & Instagram', description: 'Answer WhatsApp, Facebook Messenger and Instagram messages from the same inbox, with the same bot, routing and AI.',
  init() {
    on('message.created', ({ conv, message }) => {
      if (!conv.channel || conv.channel === 'web' || !['agent', 'bot'].includes(message.sender) || !conv.channel_id) return;
      if (skipOutbound.delete(message.id)) return;
      deliver(getConv(conv.id), message).catch(e => console.error('channel delivery:', e));
    });
  },
  routes: [
    { method: 'GET', path: '/api/channels/webhook/:token', auth: 'public', handler: c => {
      const ch = db.prepare('SELECT * FROM channels WHERE webhook_token=?').get(c.params.token);
      if (!ch || c.query.get('hub.mode') !== 'subscribe' || c.query.get('hub.verify_token') !== ch.verify_token) fail(403, 'Verification failed');
      c.res.writeHead(200, { 'Content-Type': 'text/plain' }); c.res.end(c.query.get('hub.challenge') || '');
    } },
    { method: 'POST', path: '/api/channels/webhook/:token', auth: 'public', handler: async c => {
      const row = db.prepare('SELECT * FROM channels WHERE webhook_token=?').get(c.params.token); if (!row) fail(404, 'Unknown channel');
      const raw = await c.raw(5_000_000), ch = withSecrets(row);
      if (!validSignature(raw, c.req.headers['x-hub-signature-256'], ch.app_secret)) fail(401, 'Invalid signature');
      if (!ch.enabled || !isEnabled(ch.workspace_id, 'channels') || db.prepare('SELECT suspended FROM workspaces WHERE id=?').get(ch.workspace_id)?.suspended) return { ok: true };
      let parsed; try { parsed = parseWebhook(JSON.parse(raw.toString())); } catch { fail(400, 'Bad payload'); }
      for (const s of parsed.statuses) {
        const m = db.prepare('SELECT m.id, m.conv_id FROM messages m WHERE m.external_id=?').get(s.id); if (!m) continue;
        db.prepare('UPDATE messages SET delivery=? WHERE id=?').run(s.status, m.id);
        const conv = getConv(m.conv_id); toAgents(conv.workspace_id, conv.site_id, 'message_status', { conv_id: conv.id, id: m.id, delivery: s.status }, conv);
        if (s.status === 'failed' && s.error) addMessage(conv, 'note', `⚠️ ${TYPES[ch.type].label} could not deliver a message: ${s.error}`, { senderName: 'System' });
      }
      for (const m of parsed.messages) {
        if (m.accountId && ![ch.account_id, ch.page_id].includes(String(m.accountId))) continue; // not for this number/page
        await receive(ch, m).catch(e => console.error('channel inbound:', e));
      }
      return { ok: true };
    } },
    { method: 'GET', path: '/api/channels', auth: 'ws', perm: 'settings.manage', handler: c => ({
      channels: db.prepare('SELECT * FROM channels WHERE workspace_id=? ORDER BY id').all(c.ws).map(x => chOut(x, origin(c))), dataKey: !!process.env.DATA_KEY }) },
    { method: 'POST', path: '/api/channels', auth: 'ws', perm: 'settings.manage', handler: async c => {
      const b = await c.body(), type = b.type; if (!TYPES[type]) fail(400, 'Choose WhatsApp, Messenger or Instagram');
      const site = Number(b.site_id) || c.auth.siteIds[0]; if (!c.auth.siteIds.includes(site)) fail(400, 'Unknown website');
      const account = str(b.account_id, 40).replace(/\s/g, ''), token = str(b.token, 1000), secret = str(b.app_secret, 200), page = str(b.page_id, 40) || null;
      if (!/^\d{5,30}$/.test(account)) fail(400, type === 'whatsapp' ? 'Enter the Phone number ID (digits) from WhatsApp → API setup' : 'Enter the numeric Page / Instagram account ID');
      if (!token || !secret) fail(400, 'The access token and app secret are required');
      if (db.prepare('SELECT 1 FROM channels WHERE type=? AND account_id=?').get(type, account)) fail(409, 'That account is already connected');
      let display; try { display = await probe(type, account, token); } catch (e) { fail(400, `Meta rejected these credentials: ${e.message}`); }
      const id = db.prepare('INSERT INTO channels(workspace_id,site_id,type,name,account_id,page_id,display,token,app_secret,verify_token,webhook_token,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(c.ws, site, type, str(b.name, 60) || TYPES[type].label, account, page, display, seal(token), seal(secret), rnd(12), rnd(18), now()).lastInsertRowid;
      c.log('channel.connected', `${TYPES[type].label} ${display}`);
      return { channel: chOut(db.prepare('SELECT * FROM channels WHERE id=?').get(id), origin(c)) };
    } },
    { method: 'PUT', path: '/api/channels/:id', auth: 'ws', perm: 'settings.manage', handler: async c => {
      const ch = db.prepare('SELECT * FROM channels WHERE id=? AND workspace_id=?').get(c.int('id'), c.ws) || fail(404, 'Channel not found'), b = await c.body();
      if ('site_id' in b && !c.auth.siteIds.includes(Number(b.site_id))) fail(400, 'Unknown website');
      const token = str(b.token, 1000), secret = str(b.app_secret, 200);
      if (token) { try { await probe(ch.type, ch.account_id, token); } catch (e) { fail(400, `Meta rejected this token: ${e.message}`); } }
      db.prepare('UPDATE channels SET name=?, site_id=?, enabled=?, token=COALESCE(?,token), app_secret=COALESCE(?,app_secret) WHERE id=?')
        .run(str(b.name ?? ch.name, 60) || ch.name, 'site_id' in b ? Number(b.site_id) : ch.site_id, 'enabled' in b ? (b.enabled ? 1 : 0) : ch.enabled, token ? seal(token) : null, secret ? seal(secret) : null, ch.id);
      c.log('channel.updated', ch.display);
      return { channel: chOut(db.prepare('SELECT * FROM channels WHERE id=?').get(ch.id), origin(c)) };
    } },
    { method: 'POST', path: '/api/channels/:id/test', auth: 'ws', perm: 'settings.manage', handler: async c => {
      const ch = withSecrets(db.prepare('SELECT * FROM channels WHERE id=? AND workspace_id=?').get(c.int('id'), c.ws)) || fail(404, 'Channel not found');
      try { const display = await probe(ch.type, ch.account_id, ch.token); db.prepare('UPDATE channels SET display=?, last_error=NULL WHERE id=?').run(display, ch.id); return { ok: true, display }; }
      catch (e) { setError(ch.id, e.message); return { ok: false, error: e.message }; }
    } },
    { method: 'DELETE', path: '/api/channels/:id', auth: 'ws', perm: 'settings.manage', handler: c => {
      const ch = db.prepare('SELECT * FROM channels WHERE id=? AND workspace_id=?').get(c.int('id'), c.ws) || fail(404, 'Channel not found');
      db.prepare('DELETE FROM channels WHERE id=?').run(ch.id); c.log('channel.disconnected', `${TYPES[ch.type].label} ${ch.display}`); return {};
    } },
    { method: 'POST', path: '/api/conversations/:id/template', auth: 'ws', perm: 'chats.reply', handler: async c => {
      const conv = loadConv(c, c.int('id')); if (conv.channel !== 'whatsapp') fail(400, 'Templates are for WhatsApp conversations');
      const ch = withSecrets(db.prepare('SELECT * FROM channels WHERE id=?').get(conv.channel_id)); if (!ch?.enabled) fail(400, 'The WhatsApp channel is disconnected');
      const b = await c.body(), name = str(b.name, 100).toLowerCase(), language = str(b.language, 10) || 'en', params = (Array.isArray(b.params) ? b.params : []).map(p => str(String(p), 500)).slice(0, 10);
      if (!/^[a-z0-9_]+$/.test(name)) fail(400, 'Enter the template name exactly as approved in WhatsApp Manager');
      let id; try { id = await sendTemplate(ch, conv.visitor_id.split(':')[1].replace(/^wa_/, ''), { name, language, params }); } catch (e) { fail(400, `WhatsApp refused the template: ${e.message}`); }
      db.prepare("UPDATE conversations SET bot_active=0, needs_human=0, assignee_id=COALESCE(assignee_id,?) WHERE id=?").run(c.me.id, conv.id);
      const m = addMessage(getConv(conv.id), 'agent', `📋 Template “${name}”${params.length ? ': ' + params.join(' · ') : ''}`, { senderId: c.me.id, senderName: c.me.name });
      skipOutbound.add(m.id); db.prepare("UPDATE messages SET external_id=?, delivery='sent' WHERE id=?").run(id, m.id); emitConv(getConv(conv.id));
      return { message: { ...m, delivery: 'sent' } };
    } },
  ],
});
