// Notification center: bell + panel, realtime toasts/desktop alerts, preferences screen and browser push.
import { S, api, h, icon, toast, guard, beep, appendTo } from './core.js';

export const N = { unread: 0, items: [], open: false, loaded: false };
const ICON = { 'chat.new': '💬', 'chat.handoff': '🙋', 'chat.message': '✉️', 'chat.assigned': '👉', 'chat.mention': '@', 'chat.unanswered': '⏰', 'chat.rated': '⭐',
  'team.added': '👋', 'workspace.status': '⛔', 'system.announcement': '📣', 'platform.signup': '🏢', 'platform.fraud': '🛡' };
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : new Date(t).toLocaleDateString(); };
const local = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };
export const soundOn = () => local('chatly_sound') !== '0';
export const desktopOn = () => local('chatly_desktop') !== '0';

let navigate = () => {};
/** The shell registers how to open a notification link (keeps this module free of page imports). */
export function setNavigator(fn) { navigate = fn; }

export async function loadNotifications() {
  const d = await api('/notifications?limit=30').catch(() => null); if (!d) return;
  N.items = d.items; N.unread = d.unread; N.loaded = true; drawBell(); drawPanel();
}
export function bellButton() {
  return h('a', { class: 'bell', id: 'bell', title: 'Notifications', onclick: e => { e.stopPropagation(); N.open = !N.open; drawPanel(); if (N.open && !N.loaded) loadNotifications(); } },
    icon('bell'), h('span', { class: 'lbl' }, 'Notifications'), h('span', { class: 'cnt', id: 'bellcnt', style: N.unread ? '' : 'display:none' }, N.unread > 99 ? '99+' : N.unread));
}
function drawBell() {
  const c = document.getElementById('bellcnt'); if (!c) return;
  c.textContent = N.unread > 99 ? '99+' : N.unread; c.style.display = N.unread ? '' : 'none';
  document.title = (N.unread ? `(${N.unread}) ` : '') + 'Chatly Dashboard';
}
const markRead = guard(async ids => { const r = await api('/notifications/read', 'POST', ids ? { ids } : { all: true }); N.unread = r.unread; for (const n of N.items) if (!ids || ids.includes(n.id)) n.read_at = n.read_at || Date.now(); drawBell(); drawPanel(); });
function item(n) {
  return h('div', { class: 'nitem' + (n.read_at ? '' : ' is-unread'), onclick: () => { if (!n.read_at) markRead([n.id]); N.open = false; drawPanel(); navigate(n); } },
    h('div', { class: 'nico' }, ICON[n.type] || '🔔'),
    h('div', { class: 'nbody' }, h('b', {}, n.title), n.body ? h('div', { class: 'ntext' }, n.body) : null,
      h('div', { class: 'hint', style: 'margin:2px 0 0' }, ago(n.created), n.workspace_name && S.workspaces.length > 1 ? ' · ' + n.workspace_name : '')));
}
export function drawPanel() {
  document.querySelector('.npanel')?.remove();
  if (!N.open) return;
  const p = h('div', { class: 'npanel', onclick: e => e.stopPropagation() },
    h('div', { class: 'row', style: 'padding:12px 14px;border-bottom:1px solid var(--bd)' }, h('b', { class: 'grow' }, 'Notifications'),
      N.unread ? h('button', { class: 'btn sec sm', onclick: () => markRead(null) }, 'Mark all read') : null,
      h('button', { class: 'btn sec sm', title: 'Notification settings', onclick: () => { N.open = false; drawPanel(); navigate({ link: 'settings/notifications' }); } }, icon('cog', 14))),
    h('div', { class: 'nlist' }, ...(N.items.length ? N.items.map(item) : [h('div', { class: 'empty' }, h('div', { class: 'big' }, '🔔'), N.loaded ? "You're all caught up" : 'Loading…')])));
  document.body.append(p);
}
document.addEventListener('click', () => { if (N.open) { N.open = false; drawPanel(); } });

/** Called by the realtime stream for every new notification. */
export function onNotification(n) {
  N.items.unshift({ ...n, read_at: null }); N.items = N.items.slice(0, 50); N.unread = n.unread ?? N.unread + 1;
  drawBell(); drawPanel();
  if (soundOn() && !['system.announcement'].includes(n.type)) beep();
  if (document.hidden && desktopOn() && 'Notification' in window && Notification.permission === 'granted') {
    const d = new Notification(n.title, { body: n.body || '', tag: 'chatly-' + n.id });
    d.onclick = () => { window.focus(); navigate(n); d.close(); };
  } else toast(`${ICON[n.type] || '🔔'} ${n.title}`);
}
export function onReadSync(d) { N.unread = d.unread; if (!d.unread) for (const n of N.items) n.read_at = n.read_at || Date.now(); drawBell(); drawPanel(); }

// ---------- browser push ----------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function currentSub() { if (!pushSupported()) return null; const reg = await navigator.serviceWorker.getRegistration('/app/'); return reg ? reg.pushManager.getSubscription() : null; }
export async function enablePush(publicKey) {
  if (!pushSupported()) throw new Error('This browser does not support push notifications');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site in your browser settings');
  const reg = await navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }); await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('/notifications/push', 'POST', sub.toJSON());
}
export async function disablePush() { const sub = await currentSub(); if (sub) { await api('/notifications/push', 'DELETE', { endpoint: sub.endpoint }); await sub.unsubscribe(); } }

// ---------- preferences screen (Settings → Notifications) ----------
export async function renderNotificationPrefs(page, { siteBar, canManageSite }) {
  const d = await api('/notifications/prefs');
  const sub = await currentSub().catch(() => null);
  const groups = {}; for (const t of d.types) (groups[t.group] ||= []).push(t);
  const save = guard(async (type, ch, val) => { await api('/notifications/prefs', 'PUT', { types: { [type]: { [ch]: val } } }); toast('Saved'); });
  const pushState = h('span', { class: 'pill ' + (sub ? 'ok' : '') }, sub ? 'on for this browser' : 'off for this browser');
  const s = d.settings;
  const qe = h('input', { type: 'checkbox', checked: s.quietEnabled }), qs = h('input', { type: 'time', value: s.quietStart }), qn = h('input', { type: 'time', value: s.quietEnd }),
    tz = h('input', { value: s.timezone, placeholder: 'e.g. Africa/Lagos' });
  appendTo(page,
    h('div', { class: 'card' }, h('h3', {}, 'Where you get notified'),
      h('p', { class: 'hint' }, `Email and push are only sent when you're not looking at the dashboard. ${d.email.configured ? `Emails go to ${d.email.address}.` : 'Email is not configured on this server (SMTP_URL).'}`),
      h('table', { class: 'prefs' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'In-app'), h('th', {}, 'Email'), h('th', {}, 'Push'))),
        h('tbody', {}, ...Object.entries(groups).flatMap(([g, list]) => [h('tr', {}, h('td', { colspan: 4, class: 'pgroup' }, g)),
          ...list.map(t => h('tr', {}, h('td', {}, h('b', {}, t.label), h('div', { class: 'hint', style: 'margin:0' }, t.description)),
            ...['in_app', 'email', 'push'].map(ch => h('td', {}, h('input', { type: 'checkbox', checked: t.channels[ch], 'aria-label': `${t.label}: ${ch}`, onchange: e => save(t.key, ch, e.target.checked) }))))) ])))),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h3', {}, 'This browser'),
        h('div', { class: 'row', style: 'margin:8px 0' }, h('b', { class: 'grow' }, 'Push notifications'), pushState),
        h('p', { class: 'hint' }, 'Get notified even when the dashboard is closed. Works in Chrome, Edge, Firefox and Safari (macOS/iOS 16.4+, add to Home Screen on iPhone).'),
        h('div', { class: 'row', style: 'flex-wrap:wrap' },
          sub ? h('button', { class: 'btn sec', onclick: guard(async () => { await disablePush(); toast('Push turned off for this browser'); refresh(); }) }, 'Turn off')
            : h('button', { class: 'btn', onclick: guard(async () => { await enablePush(d.push.publicKey); toast('Push turned on for this browser'); refresh(); }) }, 'Turn on push'),
          h('button', { class: 'btn sec', onclick: guard(async () => { const r = await api('/notifications/test', 'POST'); toast(`Test sent: in-app ✓${r.delivered.email ? ', email ✓' : ''}${r.delivered.push ? `, push to ${r.delivered.push} device(s) ✓` : ''}`); }) }, 'Send test')),
        h('label', { class: 'inline', style: 'margin-top:14px' }, h('input', { type: 'checkbox', checked: soundOn(), onchange: e => local('chatly_sound', e.target.checked ? '1' : '0') }), 'Play a sound'),
        h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: desktopOn(), onchange: async e => { local('chatly_desktop', e.target.checked ? '1' : '0'); if (e.target.checked && 'Notification' in window) await Notification.requestPermission(); } }), 'Desktop alerts while the dashboard is in a background tab')),
      h('div', { class: 'card' }, h('h3', {}, 'Quiet hours'), h('p', { class: 'hint' }, 'No email or push during these hours. Notifications still collect in the bell.'),
        h('label', { class: 'inline' }, qe, 'Enable quiet hours'), h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'From'), qs), h('div', {}, h('label', {}, 'To'), qn)), h('label', {}, 'Timezone'), tz,
        h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { await api('/notifications/prefs', 'PUT', { settings: { quietEnabled: qe.checked, quietStart: qs.value, quietEnd: qn.value, timezone: tz.value || 'UTC' } }); toast('Quiet hours saved'); }) }, 'Save'))),
    canManageSite ? await slaCard(siteBar) : null);
  function refresh() { navigate({ link: 'settings/notifications' }); }
}
async function slaCard(siteBar) {
  const { settings } = await api('/settings');
  const mins = h('input', { type: 'number', min: 0, max: 1440, value: settings.slaMinutes ?? 5, style: 'width:120px' });
  const en = h('input', { type: 'checkbox', checked: settings.emailNotifications });
  return h('div', { class: 'card' }, h('h3', {}, 'Team alerts for this website'), siteBar(),
    h('label', {}, 'Response-time target (minutes)'), mins, h('div', { class: 'hint' }, 'Alert the team when a visitor waits longer than this without a reply. 0 turns it off.'),
    h('label', { class: 'inline', style: 'margin-top:10px' }, en, 'Allow email notifications to the team for this website'),
    h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { await api('/settings', 'PUT', { slaMinutes: +mins.value, emailNotifications: en.checked }); toast('Saved'); }) }, 'Save'));
}
