/**
 * Notifications (core). Listens to domain events and delivers notifications to the right people through
 * three channels — in-app (notification center + realtime), email and web push — according to each
 * user's preferences, quiet hours and presence (no email/push while they're looking at the dashboard).
 */
import { db, now, getSettings } from '../../core/db.js';
import { fail, str } from '../../core/http.js';
import { on } from '../../core/events.js';
import { defineModule, isEnabled } from '../../core/modules.js';
import { membersWith, memberOf, memberPerms, platformAdmins } from '../../core/auth.js';
import { sendMail, mailConfigured } from '../../core/mail.js';
import { toUser, userOnline } from '../../core/realtime.js';
import { siteRow, getVisitor } from '../livechat/service.js';
import { vapidKeys, sendPush, endpointAllowed } from './push.js';

db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT, created INTEGER NOT NULL, read_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id);
CREATE TABLE IF NOT EXISTS notification_prefs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, in_app INTEGER NOT NULL, email INTEGER NOT NULL, push INTEGER NOT NULL, PRIMARY KEY (user_id, type));
CREATE TABLE IF NOT EXISTS user_prefs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, ua TEXT, created INTEGER NOT NULL);
`);
try { db.exec('ALTER TABLE conversations ADD COLUMN sla_notified INTEGER'); } catch { /* exists */ }

/** Notification types: who gets them is decided by the event handlers below; defaults are per channel. */
export const TYPES = {
  'chat.new': { group: 'Conversations', label: 'New conversation', description: 'A visitor starts a new chat on a website you handle', in_app: 1, email: 0, push: 0 },
  'chat.handoff': { group: 'Conversations', label: 'Visitor asks for a human', description: 'The bot handed a chat over to the team', in_app: 1, email: 1, push: 1 },
  'chat.message': { group: 'Conversations', label: 'New message in my chats', description: 'A visitor replies in a conversation assigned to you', in_app: 1, email: 1, push: 1 },
  'chat.assigned': { group: 'Conversations', label: 'Assigned to me', description: 'Someone assigns a conversation to you', in_app: 1, email: 1, push: 1 },
  'chat.mention': { group: 'Conversations', label: 'Mentioned in a note', description: 'A teammate @mentions you in an internal note', in_app: 1, email: 1, push: 1 },
  'chat.unanswered': { group: 'Conversations', label: 'Visitor waiting too long', description: 'Nobody replied within the website\'s response target', in_app: 1, email: 1, push: 1 },
  'chat.rated': { group: 'Conversations', label: 'Chat rated', description: 'A visitor rates a conversation you handled', in_app: 1, email: 0, push: 0 },
  'team.added': { group: 'Workspace', label: 'Added to a workspace', description: 'You were invited to a workspace', in_app: 1, email: 1, push: 0 },
  'workspace.status': { group: 'Workspace', label: 'Workspace suspended or restored', description: 'Your workspace was suspended or reactivated', in_app: 1, email: 1, push: 1 },
  'system.announcement': { group: 'Workspace', label: 'Platform announcements', description: 'News and maintenance notices from the platform', in_app: 1, email: 0, push: 0 },
  'platform.signup': { group: 'Platform', label: 'New business signed up', description: 'A new workspace was created', in_app: 1, email: 0, push: 0, platform: true },
  'platform.fraud': { group: 'Platform', label: 'Fraud needs review', description: 'Risky activity was flagged or blocked', in_app: 1, email: 1, push: 1, platform: true },
};
const CHANNELS = ['in_app', 'email', 'push'];
const SETTINGS_DEFAULTS = { quietEnabled: false, quietStart: '22:00', quietEnd: '07:00', timezone: 'UTC' };

export function prefsFor(userId) {
  const rows = Object.fromEntries(db.prepare('SELECT * FROM notification_prefs WHERE user_id=?').all(userId).map(r => [r.type, r]));
  return Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, Object.fromEntries(CHANNELS.map(ch => [ch, !!(rows[k] ? rows[k][ch] : t[ch])]))]));
}
export function userSettings(userId) {
  const out = { ...SETTINGS_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM user_prefs WHERE user_id=?').all(userId)) out[r.key] = JSON.parse(r.value);
  return out;
}
function inQuietHours(userId) {
  const s = userSettings(userId); if (!s.quietEnabled) return false;
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: s.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
    const t = `${p.hour}:${p.minute}`;
    return s.quietStart <= s.quietEnd ? t >= s.quietStart && t < s.quietEnd : t >= s.quietStart || t < s.quietEnd;
  } catch { return false; }
}

const throttle = new Map();
/** True if this (key) was already delivered within `ms`. */
function throttled(key, ms) { const t = now(), last = throttle.get(key); if (last && t - last < ms) return true; throttle.set(key, t); return false; }
setInterval(() => { const t = now(); for (const [k, v] of throttle) if (t - v > 3_600_000) throttle.delete(k); }, 600_000).unref();

const appUrl = link => (process.env.PUBLIC_URL || '').replace(/\/$/, '') + '/app/' + (link ? '#' + link : '');
const logErr = e => console.error('notification error:', e.message);

/**
 * Delivers a notification.
 * @param {number[]} userIds
 * @param {{type: string, ws?: number|null, title: string, body?: string, link?: string, throttleKey?: string, throttleMs?: number,
 *          skipOnline?: boolean, email?: {subject?: string, text?: string}, noEmail?: boolean, urgent?: boolean, channels?: object}} n
 *        channels overrides the user's preferences (used by the test button).
 */
export function notify(userIds, n) {
  const delivered = { in_app: 0, email: 0, push: 0 };
  for (const userId of new Set(userIds)) {
    const user = db.prepare('SELECT id, email, name, disabled FROM users WHERE id=?').get(userId); if (!user || user.disabled) continue;
    const pref = n.channels || prefsFor(userId)[n.type] || { in_app: true, email: false, push: false };
    if (n.throttleKey && throttled(`${userId}:${n.type}:${n.throttleKey}`, n.throttleMs ?? 600_000)) continue;
    if (pref.in_app) {
      const id = db.prepare('INSERT INTO notifications(user_id,workspace_id,type,title,body,link,created) VALUES(?,?,?,?,?,?,?)').run(userId, n.ws ?? null, n.type, n.title, n.body || null, n.link || null, now()).lastInsertRowid;
      toUser(userId, 'notification', { id: Number(id), type: n.type, workspace_id: n.ws ?? null, title: n.title, body: n.body || null, link: n.link || null, created: now(), unread: unreadCount(userId) });
      delivered.in_app++;
    }
    const online = userOnline(userId), quiet = inQuietHours(userId);
    if (quiet || (online && n.skipOnline !== false)) continue; // they'll see it in the dashboard, or it's their night
    if (pref.email && !n.noEmail && mailConfigured()) {
      sendMail({ to: user.email, subject: n.email?.subject || n.title, text: `${n.email?.text || n.body || ''}\n\nOpen Chatly: ${appUrl(n.link)}\n\nManage notifications: ${appUrl('settings/notifications')}` }).catch(logErr);
      delivered.email++;
    }
    if (pref.push) {
      for (const sub of db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(userId)) {
        delivered.push++;
        sendPush(sub, { title: n.title, body: n.body || '', url: appUrl(n.link), tag: n.throttleKey || n.type }, { urgency: n.urgent ? 'high' : 'normal' })
          .then(r => { if (r === 'gone') db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id); });
      }
    }
  }
  return delivered;
}
export const unreadCount = userId => db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL').get(userId).n;

// ---------- recipients ----------
/** Teammates who can reply on the conversation's website and are allowed to see it. */
function responders(conv) {
  const dept = conv.department_id && !conv.assignee_id && isEnabled(conv.workspace_id, 'departments')
    ? new Set(db.prepare('SELECT user_id FROM department_members WHERE department_id=?').all(conv.department_id).map(r => r.user_id)) : null;
  return membersWith(conv.workspace_id, 'chats.reply', conv.site_id)
    .filter(m => !conv.assignee_id || conv.assignee_id === m.id || m.system || JSON.parse(m.permissions).includes('chats.view_all'))
    .filter(m => !dept?.size || dept.has(m.id)); // a department with members gets its own chats; an empty one falls back to everyone
}
/** Recipients for "new chat" style alerts: an auto-routed assignee hears about it through chat.assigned instead. */
const autoRouted = new Set(); // conversation ids whose assignee was just told by an auto-routing notification
const watchers = conv => { const skip = autoRouted.delete(conv.id) ? conv.assignee_id : null; return responders(conv).map(m => m.id).filter(id => id !== skip); };
const vname = v => v?.name || v?.email || 'A visitor';
const site = conv => siteRow(conv.site_id)?.name || 'your website';
const convLink = conv => `inbox/${conv.workspace_id}/${conv.id}`;

/** Finds @mentions of teammates in a note: @first-name, @full-name (spaces removed) or @email-name. */
export function mentionedMembers(ws, text, authorId) {
  const lower = ` ${String(text).toLowerCase()}`;
  return db.prepare('SELECT u.id, u.name, u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?').all(ws)
    .filter(u => u.id !== authorId && [u.name.split(/\s+/)[0], u.name.replace(/\s+/g, ''), u.email.split('@')[0]]
      .some(h => h && new RegExp(`[\\s(]@${h.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(lower)));
}

// ---------- response-time (SLA) monitor ----------
/** Notifies when a visitor's latest message has waited longer than the website's target with no human reply. */
export function runSlaCheck() {
  const rows = db.prepare(`SELECT c.*, (SELECT MAX(id) FROM messages WHERE conv_id=c.id AND sender='visitor') last_vid,
      (SELECT created FROM messages WHERE id=(SELECT MAX(id) FROM messages WHERE conv_id=c.id AND sender='visitor')) last_vt,
      (SELECT MAX(id) FROM messages WHERE conv_id=c.id AND sender='agent') last_aid
    FROM conversations c WHERE c.status='open' AND c.bot_active=0 AND c.spam=0`).all();
  let sent = 0;
  for (const c of rows) {
    if (!c.last_vid || (c.last_aid && c.last_aid > c.last_vid) || c.sla_notified === c.last_vid) continue;
    const mins = getSettings(c.site_id).slaMinutes ?? 5; if (!mins) continue;
    if (now() - c.last_vt < mins * 60_000) continue;
    db.prepare('UPDATE conversations SET sla_notified=? WHERE id=?').run(c.last_vid, c.id);
    const v = getVisitor(c.visitor_id), waited = Math.round((now() - c.last_vt) / 60_000);
    notify(c.assignee_id ? [c.assignee_id] : responders(c).map(m => m.id), { type: 'chat.unanswered', ws: c.workspace_id, link: convLink(c), urgent: true, skipOnline: false,
      title: `${vname(v)} has been waiting ${waited} min`, body: `No reply yet on ${site(c)}: “${(c.last_body || '').slice(0, 120)}”` });
    sent++;
  }
  return sent;
}

export default defineModule({
  key: 'notifications', name: 'Notifications', description: 'In-app, email and push notifications.', core: true, hidden: true,
  init() {
    on('conversation.created', ({ conv }) => {
      if (conv.bot_active) return; // the bot is handling it; the team hears about it on handoff
      notify(watchers(conv), { type: 'chat.new', ws: conv.workspace_id, link: convLink(conv), title: `New conversation on ${site(conv)}`, body: vname(getVisitor(conv.visitor_id)) + ' started a chat' });
    });
    on('conversation.handoff', ({ conv }) => {
      const s = getSettings(conv.site_id), v = getVisitor(conv.visitor_id);
      const last = db.prepare("SELECT body FROM messages WHERE conv_id=? AND sender='visitor' ORDER BY id DESC LIMIT 1").get(conv.id)?.body || '';
      notify(watchers(conv), { type: 'chat.handoff', ws: conv.workspace_id, link: convLink(conv), urgent: true, throttleKey: 'conv' + conv.id, noEmail: !s.emailNotifications,
        title: `${vname(v)} wants to talk to a human`, body: last.slice(0, 200),
        email: { subject: `[${site(conv)}] New message from ${vname(v)} — needs a human`, text: `${last}\n\nConversation #${conv.id}${v?.email ? `\nVisitor email: ${v.email}` : ''}` } });
    });
    on('message.created', ({ conv, message }) => {
      if (message.sender !== 'visitor' || conv.bot_active) return;
      const v = getVisitor(conv.visitor_id), S = getSettings(conv.site_id);
      const to = conv.assignee_id ? [conv.assignee_id] : responders(conv).map(m => m.id);
      notify(to, { type: 'chat.message', ws: conv.workspace_id, link: convLink(conv), throttleKey: 'conv' + conv.id, throttleMs: 120_000, noEmail: !S.emailNotifications,
        title: `${vname(v)}: ${message.body.slice(0, 80)}`, body: `New message on ${site(conv)}`,
        email: { subject: `[${site(conv)}] New message from ${vname(v)}`, text: `${message.body}\n\nConversation #${conv.id}${v?.email ? `\nVisitor email: ${v.email}` : ''}` } });
    });
    on('conversation.assigned', ({ conv, assigneeId, by, auto }) => {
      if (assigneeId === by?.id) return;
      if (auto) { autoRouted.add(conv.id); setTimeout(() => autoRouted.delete(conv.id), 5000).unref(); }
      notify([assigneeId], { type: 'chat.assigned', ws: conv.workspace_id, link: convLink(conv), urgent: !!auto, title: auto ? 'A new chat was routed to you' : `${by?.name || 'Someone'} assigned you a conversation`, body: `${vname(getVisitor(conv.visitor_id))} on ${site(conv)}: “${(conv.last_body || '').slice(0, 120)}”` });
    });
    on('note.created', ({ conv, message, by }) => {
      const users = mentionedMembers(conv.workspace_id, message.body, by.id).filter(u => {
        const mem = memberOf(u.id, conv.workspace_id); if (!mem) return false;
        const perms = memberPerms(mem);
        return perms.has('chats.view') && (!mem.site_ids || JSON.parse(mem.site_ids).includes(conv.site_id)) && (!conv.assignee_id || conv.assignee_id === u.id || perms.has('chats.view_all'));
      });
      notify(users.map(u => u.id), { type: 'chat.mention', ws: conv.workspace_id, link: convLink(conv), title: `${by.name} mentioned you`, body: message.body.slice(0, 200) });
    });
    on('conversation.rated', ({ conv, rating, comment }) => {
      if (!conv.assignee_id) return;
      notify([conv.assignee_id], { type: 'chat.rated', ws: conv.workspace_id, link: convLink(conv), title: `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} rating from ${vname(getVisitor(conv.visitor_id))}`, body: comment || null });
    });
    on('conversation.unsnoozed', ({ conv }) => {
      if (conv.assignee_id) notify([conv.assignee_id], { type: 'chat.assigned', ws: conv.workspace_id, link: convLink(conv), title: '⏰ Snoozed conversation is back', body: `${vname(getVisitor(conv.visitor_id))} on ${site(conv)}` });
    });
    on('member.added', ({ ws, user, role, by, created }) => {
      const wsName = db.prepare('SELECT name FROM workspaces WHERE id=?').get(ws)?.name;
      notify([user.id], { type: 'team.added', ws, link: 'dashboard', skipOnline: false, title: `You were added to ${wsName}`, body: `${by.name} added you as ${role}.`,
        email: { subject: `You've been added to ${wsName} on Chatly`, text: `${by.name} added you as ${role}. Sign in to the Chatly dashboard with ${user.email}${created ? ' and the temporary password you were given' : ''}.` } });
    });
    const wsAdmins = ws => membersWith(ws, 'team.manage').map(m => m.id);
    on('workspace.suspended', ({ ws, reason }) => notify(wsAdmins(ws), { type: 'workspace.status', ws, skipOnline: false, title: 'Your workspace was suspended', body: reason }));
    on('workspace.reactivated', ({ ws }) => notify(wsAdmins(ws), { type: 'workspace.status', ws, title: 'Your workspace is active again', body: 'The chat widget and dashboard work normally again.' }));
    on('workspace.created', ({ name, owner }) => notify(platformAdmins().map(u => u.id).filter(id => id !== owner.id), { type: 'platform.signup', link: 'platform', title: `New workspace: ${name}`, body: `${owner.name} <${owner.email}>` }));
    on('fraud.detected', ({ kind, score, action, summary }) => notify(platformAdmins().map(u => u.id), { type: 'platform.fraud', link: 'platform/fraud', throttleKey: 'fraud', throttleMs: 10 * 60_000,
      title: `Fraud ${action === 'blocked' ? 'blocked' : 'flagged'}: ${kind.replace('_', ' ')} (score ${score})`, body: summary || 'Open the review queue for details' }));
    on('platform.announcement', ({ text }) => notify(db.prepare('SELECT id FROM users WHERE disabled=0').all().map(u => u.id), { type: 'system.announcement', title: 'Announcement', body: text }));
    setInterval(runSlaCheck, Number(process.env.SLA_CHECK_MS) || 60_000).unref();
  },
  routes: [
    { method: 'GET', path: '/api/notifications', auth: 'user', handler: c => {
      const before = Number(c.query.get('before')) || Number.MAX_SAFE_INTEGER, limit = Math.min(100, Number(c.query.get('limit')) || 30);
      const items = db.prepare('SELECT n.*, w.name workspace_name FROM notifications n LEFT JOIN workspaces w ON w.id=n.workspace_id WHERE n.user_id=? AND n.id<? ORDER BY n.id DESC LIMIT ?').all(c.me.id, before, limit);
      return { items, unread: unreadCount(c.me.id) };
    } },
    { method: 'POST', path: '/api/notifications/read', auth: 'user', handler: async c => {
      const b = await c.body();
      if (b.all) db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(), c.me.id);
      else for (const id of (Array.isArray(b.ids) ? b.ids : []).slice(0, 500)) db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL').run(now(), Number(id), c.me.id);
      const unread = unreadCount(c.me.id); toUser(c.me.id, 'notifications.read', { unread });
      return { unread };
    } },
    { method: 'DELETE', path: '/api/notifications', auth: 'user', handler: c => { db.prepare('DELETE FROM notifications WHERE user_id=? AND read_at IS NOT NULL').run(c.me.id); return { unread: unreadCount(c.me.id) }; } },
    { method: 'GET', path: '/api/notifications/prefs', auth: 'user', handler: c => {
      const prefs = prefsFor(c.me.id), isPlatform = c.me.platform_role === 'superadmin';
      return { types: Object.entries(TYPES).filter(([, t]) => !t.platform || isPlatform).map(([key, t]) => ({ key, group: t.group, label: t.label, description: t.description, channels: prefs[key] })),
        settings: userSettings(c.me.id), push: { publicKey: vapidKeys().publicKey, subscriptions: db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?').get(c.me.id).n },
        email: { configured: mailConfigured(), address: c.me.email } };
    } },
    { method: 'PUT', path: '/api/notifications/prefs', auth: 'user', handler: async c => {
      const b = await c.body();
      for (const [type, ch] of Object.entries(b.types || {})) {
        if (!TYPES[type] || typeof ch !== 'object') continue;
        const cur = prefsFor(c.me.id)[type], v = Object.fromEntries(CHANNELS.map(k => [k, k in ch ? !!ch[k] : cur[k]]));
        db.prepare('INSERT INTO notification_prefs(user_id,type,in_app,email,push) VALUES(?,?,?,?,?) ON CONFLICT(user_id,type) DO UPDATE SET in_app=excluded.in_app, email=excluded.email, push=excluded.push')
          .run(c.me.id, type, +v.in_app, +v.email, +v.push);
      }
      const s = b.settings || {};
      if ('timezone' in s) { try { new Intl.DateTimeFormat('en', { timeZone: s.timezone }); } catch { fail(400, 'Unknown timezone'); } }
      for (const k of ['quietStart', 'quietEnd']) if (k in s && !/^\d\d:\d\d$/.test(s[k])) fail(400, 'Times must look like 22:00');
      for (const [k, v] of Object.entries(s)) if (k in SETTINGS_DEFAULTS) db.prepare('INSERT INTO user_prefs(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value').run(c.me.id, k, JSON.stringify(k === 'quietEnabled' ? !!v : str(String(v), 60)));
      return { types: prefsFor(c.me.id), settings: userSettings(c.me.id) };
    } },
    { method: 'POST', path: '/api/notifications/push', auth: 'user', handler: async c => {
      const b = await c.body(), endpoint = str(b.endpoint, 1000), p256dh = str(b.keys?.p256dh, 200), auth = str(b.keys?.auth, 100);
      if (!endpointAllowed(endpoint)) fail(400, 'Unsupported push service endpoint');
      if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) fail(400, 'Invalid subscription keys');
      if (db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?').get(c.me.id).n >= 10) db.prepare('DELETE FROM push_subscriptions WHERE id=(SELECT MIN(id) FROM push_subscriptions WHERE user_id=?)').run(c.me.id);
      db.prepare('INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,ua,created) VALUES(?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth')
        .run(c.me.id, endpoint, p256dh, auth, str(c.req.headers['user-agent'], 200), now());
      return { ok: true };
    } },
    { method: 'DELETE', path: '/api/notifications/push', auth: 'user', handler: async c => {
      db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(c.me.id, str((await c.body()).endpoint, 1000)); return {};
    } },
    { method: 'POST', path: '/api/notifications/test', auth: 'user', handler: c => {
      const delivered = notify([c.me.id], { type: 'system.announcement', title: '🔔 Test notification', body: 'Notifications are working on this device.', skipOnline: false, channels: { in_app: true, email: true, push: true } });
      return { delivered };
    } },
  ],
});
