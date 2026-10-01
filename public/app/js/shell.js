import { renderLogin } from './auth.js';
import { renderBot } from './chatbot.js';
import { renderContacts } from './contacts.js';
import { S, api, avEl, can, guard, h, icon, setTheme, mod, toast, $app } from './core.js';
import { bellButton, loadNotifications, setNavigator, N } from './notifications.js';
import { renderDashboard } from './dashboard.js';
import { renderInbox } from './inbox.js';
import { renderPlatform, openPlatformTab } from './platform.js';
import { connect } from './realtime.js';
import { renderSettings, openSettingsTab } from './settings.js';
import { renderTriggers } from './triggers.js';
import { renderVisitors } from './visitors.js';

// ---------- shell ----------
export function renderNoWorkspace() {
  const name = h('input', { placeholder: 'e.g. Acme Inc.' });
  $app.replaceChildren(h('div', { class: 'login-bg' }, h('div', { class: 'login' }, h('h1', {}, 'No workspace yet'), h('p', { class: 'hint' }, "You aren't a member of any workspace. Create one to get started."),
    h('label', {}, 'Workspace name'), name, h('button', { class: 'btn', style: 'margin-top:14px', onclick: guard(async () => { await api('/workspaces', 'POST', { name: name.value }); boot(); }) }, 'Create workspace'),
    h('button', { class: 'btn sec', style: 'margin:14px 0 0 8px', onclick: async () => { await api('/auth/logout', 'POST'); renderLogin(); } }, 'Sign out'))));
}
export const switchWorkspace = guard(async id => {
  if (id === 'new') { const n = prompt('Name of the new workspace'); if (!n) return renderShell(); await api('/workspaces', 'POST', { name: n }); }
  else await api('/workspaces/switch', 'POST', { id: +id });
  S.site = 0; S.view = 'dashboard'; await boot();
});
export async function boot() {
  let d; try { d = await api('/me'); } catch { return renderLogin(); }
  if (!d?.user) return;
  S.me = d.user; S.role = d.role; S.workspace = d.workspace; S.workspaces = d.workspaces; S.perms = new Set(d.permissions); S.sites = d.sites; S.catalog = d.catalog;
  S.aiConfigured = d.aiConfigured; S.mailConfigured = d.mailConfigured;
  S.announcement = d.announcement; S.modules = d.modules || [];
  N.loaded = false; loadNotifications();
  if (!S.workspace) return S.me.platform_role === 'superadmin' ? (S.view = 'platform', connect(), renderShell(), openPendingLink()) : renderNoWorkspace();
  if (S.site && !S.sites.some(x => x.id === S.site)) S.site = 0;
  S.convs = new Map(); S.cur = null;
  if (!S.me) return;
  const [a, c, dep] = await Promise.all([api('/members'), api('/canned'), mod('departments') ? api('/departments').catch(() => null) : null]);
  S.members = a.members; S.canned = c.canned; S.departments = dep?.departments || []; S.routing = dep?.routing || null;
  S.views = []; S.viewsLoaded = false; S.view_id = ''; S.selected.clear(); S.f = { priority: '', department: '', assignee: '' };
  connect(); renderShell(); openPendingLink();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}
export function totalUnread() { let n = 0; for (const c of S.convs.values()) if (c.status === 'open') n += c.unread ? 1 : 0; return n; }
export function renderShell() {
  const link = (v, ic, label) => h('a', { 'data-v': v, class: S.view === v ? 'on' : '', onclick: () => { S.view = v; renderShell(); } }, icon(ic), h('span', { class: 'lbl' }, label),
    v === 'inbox' && totalUnread() ? h('span', { class: 'cnt' }, totalUnread()) : null);
  const views = { platform: renderPlatform, inbox: renderInbox, contacts: renderContacts, visitors: renderVisitors, bot: renderBot, triggers: renderTriggers, settings: renderSettings, dashboard: renderDashboard };
  const main = h('div', { class: 'main', id: 'main' });
  const banner = [S.announcement ? h('div', { class: 'announce' }, '📣 ', S.announcement) : null,
    S.me.email_verified === false ? h('div', { class: 'announce warnbar' }, '✉️ Please confirm your email address — check your inbox. ', h('a', { href: '#', onclick: guard(async e => { e.preventDefault(); await api('/auth/verify/resend', 'POST'); toast('Confirmation email sent to ' + S.me.email); }) }, 'Resend the link')) : null];
  const flash = sessionStorage.getItem('chatly_flash'); if (flash) { sessionStorage.removeItem('chatly_flash'); setTimeout(() => toast(flash), 300); }
  const dark = document.documentElement.dataset.theme === 'dark';
  $app.replaceChildren(h('div', { class: 'shell' },
    h('div', { class: 'nav' }, h('div', { class: 'brand' }, h('div', { class: 'lg' }, icon('logo')), h('span', {}, 'Chatly')), bellButton(),
      h('div', { class: 'switch' },
        h('select', { title: 'Workspace', onchange: e => switchWorkspace(e.target.value) }, ...S.workspaces.map(w => h('option', { value: w.id, selected: w.id === S.workspace?.id }, w.name)), h('option', { value: 'new' }, '+ New workspace…')),
        S.sites.length > 1 ? h('select', { title: 'Website', onchange: e => { S.site = +e.target.value; S.convs = new Map(); S.cur = null; renderShell(); } },
          h('option', { value: 0 }, 'All websites'), ...S.sites.map(x => h('option', { value: x.id, selected: x.id === S.site }, x.name))) : null),
      S.workspace && can('chats.view') ? [link('dashboard', 'home', 'Overview'), link('inbox', 'inbox', 'Inbox')] : null,
      can('contacts.view') || can('chats.view') ? h('div', { class: 'sec' }, 'People') : null, can('contacts.view') && mod('contacts') ? link('contacts', 'users', 'Contacts') : null, can('chats.view') ? link('visitors', 'eye', 'Live visitors') : null,
      can('bot.manage') && (mod('chatbot') || mod('flows') || mod('ai') || mod('triggers')) ? [h('div', { class: 'sec' }, 'Automation'),
        mod('chatbot') || mod('flows') || mod('ai') ? link('bot', 'bot', 'Chatbot & flows') : null, mod('triggers') ? link('triggers', 'zap', 'Triggers') : null] : null,
      S.workspace ? [h('div', { class: 'sec' }, 'Workspace'), link('settings', 'cog', 'Settings')] : null,
      S.me.platform_role === 'superadmin' ? [h('div', { class: 'sec' }, 'Platform'), link('platform', 'shield', 'Platform console')] : null,
      h('a', { onclick: () => { setTheme(dark ? 'light' : 'dark'); renderShell(); } }, icon(dark ? 'sun' : 'moon'), h('span', { class: 'lbl' }, dark ? 'Light mode' : 'Dark mode')),
      h('div', { class: 'me' }, avEl({ id: S.me.email, name: S.me.name }), h('div', { style: 'min-width:0' }, h('b', {}, S.me.name),
          S.workspace && can('chats.reply') ? h('button', { class: 'stat', title: 'Away: you stay signed in and notified, but the widget won\'t count you as online and no chats are routed to you',
            onclick: guard(async () => { const r = await api('/me/status', 'PUT', { status: S.me.status === 'away' ? 'available' : 'away' }); S.me.status = r.status; toast(r.status === 'away' ? 'You are now Away' : 'You are Available'); renderShell(); }) },
            h('span', { class: 'status-dot' + (S.me.status === 'away' ? ' away' : '') }), S.me.status === 'away' ? 'Away' : 'Available') : h('small', {}, S.role?.name)),
        h('button', { title: 'Sign out', onclick: async () => { await api('/auth/logout', 'POST'); S.me = null; renderLogin(); } }, icon('logout')))),
    h('div', { class: 'mainwrap' }, banner, main)));
  if (!S.workspace && S.view !== 'platform') S.view = 'platform';
  if (S.workspace?.suspended && S.view !== 'platform') { main.append(h('div', { class: 'page' }, h('div', { class: 'card empty' }, h('div', { class: 'big' }, '⛔'), h('h3', {}, 'This workspace is suspended'), h('p', {}, S.workspace.suspended), h('p', { class: 'hint' }, 'Contact support to restore access. You can still switch to another workspace from the sidebar.')))); return; }
  if (!can('chats.view') && ['dashboard', 'inbox', 'visitors'].includes(S.view)) S.view = can('contacts.view') ? 'contacts' : 'settings';
  (views[S.view] || renderSettings)(main);
}
export const refreshNavBadge = () => { const a = document.querySelector('.nav a[data-v=inbox]'); if (!a) return; a.querySelector('.cnt')?.remove(); if (totalUnread()) a.append(h('span', { class: 'cnt' }, totalUnread())); };


/** Opens a notification/deep link like "inbox/<ws>/<conv>", "platform/fraud" or "settings/notifications". */
export async function openLink(link, wsId) {
  if (!link) return;
  const [view, a, b] = String(link).replace(/^#/, '').split('/');
  if (view === 'inbox') {
    if (+a && +a !== S.workspace?.id) { await api('/workspaces/switch', 'POST', { id: +a }); await boot(); }
    S.view = 'inbox'; S.filter = 'open'; S.cur = +b || null; S.site = 0; return renderShell();
  }
  if (wsId && wsId !== S.workspace?.id) { await api('/workspaces/switch', 'POST', { id: wsId }).catch(() => {}); await boot(); }
  if (view === 'platform') { openPlatformTab(a || 'overview'); S.view = 'platform'; }
  else if (view === 'settings') { openSettingsTab(a || 'widget'); S.view = 'settings'; }
  else S.view = ['dashboard', 'contacts', 'visitors', 'bot', 'triggers'].includes(view) ? view : 'dashboard';
  renderShell();
}
setNavigator(n => openLink(n.link, n.workspace_id));
function openPendingLink() { const h0 = location.hash.slice(1); if (h0) { history.replaceState(null, '', location.pathname); openLink(h0); } }
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'open') { const u = new URL(e.data.url); openLink(u.hash.slice(1)); } });
