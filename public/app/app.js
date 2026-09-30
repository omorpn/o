(() => {
const $app = document.getElementById('app');
const S = { perms: new Set(), sites: [], site: 0, workspaces: [], members: [], catalog: {}, tag: '', tags: [], aiConfigured: false, mailConfigured: false, me: null, siteKey: '', convs: new Map(), cur: null, msgs: [], filter: 'open', q: '', visitors: new Map(), agents: [], canned: [], view: 'inbox', typing: {}, mode: 'reply', stats: null };
let es;

// ---------- utils ----------
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'value') e.value = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const CFG_PATHS = /^\/(settings|rules|kb|flows|triggers|bot\/test)(\/|$|\?)/, DATA_PATHS = /^\/(stats|analytics|conversations|contacts|visitors|export\/contacts\.csv)(\?|$)/;
const cfgSite = () => S.site || S.sites[0]?.id;
const withSite = path => {
  const add = CFG_PATHS.test(path) ? cfgSite() : DATA_PATHS.test(path) && S.site ? S.site : null;
  return add ? path + (path.includes('?') ? '&' : '?') + 'site=' + add : path;
};
const can = perm => S.perms.has(perm);
async function api(path, method = 'GET', body) {
  path = withSite(path);
  const r = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/auth/')) { S.me = null; return renderLogin(); }
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
function toast(msg) { const t = h('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2500); }
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const vname = v => v?.name || v?.email || 'Visitor ' + (v?.id || '').slice(1, 6);
const ICONS = {
  logo: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.6-.8L3 21l1.9-5.4A8.4 8.4 0 1 1 21 11.5z"/>',
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  bot: '<rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 8V4M8 14h.01M16 14h.01M9 18h6"/><circle cx="12" cy="3" r="1"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  star: '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  clip: '<path d="M21.4 11.1l-9.2 9.2a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
};
const icon = (n, size) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i'); if (size) { s.style.width = s.style.height = size + 'px'; } s.innerHTML = ICONS[n] || ''; return s; };
const HUES = ['#6366f1', '#8b5cf6', '#ec4899', '#f97316', '#10b981', '#0ea5e9', '#14b8a6', '#eab308'];
const hueOf = str => HUES[[...String(str || '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
const avEl = (v, extra) => h('div', { class: 'av', style: `background:${hueOf(v?.id || v?.name)}` }, initials(v), extra);
const setTheme = t => { document.documentElement.dataset.theme = t; try { localStorage.setItem('chatly_theme', t); } catch {} };
try { setTheme(localStorage.getItem('chatly_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')); } catch {}
const initials = v => vname(v).replace(/^Visitor /, '').slice(0, 2).toUpperCase();
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
function beep() { try { const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(), g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.setValueAtTime(.08, c.currentTime); g.gain.exponentialRampToValueAtTime(.001, c.currentTime + .25); o.start(); o.stop(c.currentTime + .25); } catch {} }

// ---------- login ----------
function renderLogin(mode = 'login') {
  if (es) es.close();
  const err = h('div', { class: 'err' });
  const f = { name: h('input', { placeholder: 'Your name', autocomplete: 'name' }), workspace: h('input', { placeholder: 'Company or team name' }),
    site: h('input', { placeholder: 'https://yourstore.com (optional)' }),
    email: h('input', { type: 'email', placeholder: 'you@company.com', autocomplete: 'username', required: true }),
    pw: h('input', { type: 'password', placeholder: mode === 'signup' ? 'At least 8 characters' : 'Password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: true }) };
  const signup = mode === 'signup';
  $app.replaceChildren(h('div', { class: 'login-bg' }, h('form', { class: 'login', onsubmit: async e => {
    e.preventDefault(); err.textContent = '';
    try {
      if (signup) await api('/auth/signup', 'POST', { name: f.name.value, workspace: f.workspace.value, domain: f.site.value, site_name: f.site.value ? f.site.value.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '', email: f.email.value, password: f.pw.value });
      else await api('/auth/login', 'POST', { email: f.email.value, password: f.pw.value });
      boot();
    } catch (x) { err.textContent = x.message; }
  } }, h('div', { class: 'logo' }, icon('logo')), h('h1', {}, signup ? 'Create your account' : 'Welcome back'),
    h('div', { class: 'hint' }, signup ? 'Free live chat, chatbot and shared inbox for your website' : 'Sign in to your Chatly dashboard'),
    signup ? [h('label', {}, 'Your name'), f.name, h('label', {}, 'Company / workspace'), f.workspace, h('label', {}, 'Website'), f.site] : null,
    h('label', {}, 'Email'), f.email, h('label', {}, 'Password'), f.pw, err,
    h('button', { class: 'btn', style: 'width:100%;margin-top:18px;justify-content:center;padding:11px' }, signup ? 'Create account' : 'Sign in'),
    h('div', { class: 'hint', style: 'text-align:center;margin-top:14px' }, signup ? 'Already have an account? ' : 'New to Chatly? ',
      h('a', { href: '#', onclick: e => { e.preventDefault(); renderLogin(signup ? 'login' : 'signup'); } }, signup ? 'Sign in' : 'Create an account')))));
}

// ---------- shell ----------
function renderNoWorkspace() {
  const name = h('input', { placeholder: 'e.g. Acme Inc.' });
  $app.replaceChildren(h('div', { class: 'login-bg' }, h('div', { class: 'login' }, h('h1', {}, 'No workspace yet'), h('p', { class: 'hint' }, "You aren't a member of any workspace. Create one to get started."),
    h('label', {}, 'Workspace name'), name, h('button', { class: 'btn', style: 'margin-top:14px', onclick: guard(async () => { await api('/workspaces', 'POST', { name: name.value }); boot(); }) }, 'Create workspace'),
    h('button', { class: 'btn sec', style: 'margin:14px 0 0 8px', onclick: async () => { await api('/auth/logout', 'POST'); renderLogin(); } }, 'Sign out'))));
}
const switchWorkspace = guard(async id => {
  if (id === 'new') { const n = prompt('Name of the new workspace'); if (!n) return renderShell(); await api('/workspaces', 'POST', { name: n }); }
  else await api('/workspaces/switch', 'POST', { id: +id });
  S.site = 0; S.view = 'dashboard'; await boot();
});
async function boot() {
  let d; try { d = await api('/me'); } catch { return renderLogin(); }
  if (!d?.user) return;
  S.me = d.user; S.role = d.role; S.workspace = d.workspace; S.workspaces = d.workspaces; S.perms = new Set(d.permissions); S.sites = d.sites; S.catalog = d.catalog;
  S.aiConfigured = d.aiConfigured; S.mailConfigured = d.mailConfigured;
  if (!S.workspace) return renderNoWorkspace();
  if (S.site && !S.sites.some(x => x.id === S.site)) S.site = 0;
  S.convs = new Map(); S.cur = null;
  if (!S.me) return;
  const [a, c] = await Promise.all([api('/members'), api('/canned')]);
  S.members = a.members; S.canned = c.canned;
  connect(); renderShell();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}
function totalUnread() { let n = 0; for (const c of S.convs.values()) if (c.status === 'open') n += c.unread ? 1 : 0; return n; }
function renderShell() {
  const link = (v, ic, label) => h('a', { 'data-v': v, class: S.view === v ? 'on' : '', onclick: () => { S.view = v; renderShell(); } }, icon(ic), h('span', { class: 'lbl' }, label),
    v === 'inbox' && totalUnread() ? h('span', { class: 'cnt' }, totalUnread()) : null);
  const views = { inbox: renderInbox, contacts: renderContacts, visitors: renderVisitors, bot: renderBot, triggers: renderTriggers, settings: renderSettings, dashboard: renderDashboard };
  const main = h('div', { class: 'main', id: 'main' });
  const dark = document.documentElement.dataset.theme === 'dark';
  $app.replaceChildren(h('div', { class: 'shell' },
    h('div', { class: 'nav' }, h('div', { class: 'brand' }, h('div', { class: 'lg' }, icon('logo')), h('span', {}, 'Chatly')),
      h('div', { class: 'switch' },
        h('select', { title: 'Workspace', onchange: e => switchWorkspace(e.target.value) }, ...S.workspaces.map(w => h('option', { value: w.id, selected: w.id === S.workspace.id }, w.name)), h('option', { value: 'new' }, '+ New workspace…')),
        S.sites.length > 1 ? h('select', { title: 'Website', onchange: e => { S.site = +e.target.value; S.convs = new Map(); S.cur = null; renderShell(); } },
          h('option', { value: 0 }, 'All websites'), ...S.sites.map(x => h('option', { value: x.id, selected: x.id === S.site }, x.name))) : null),
      can('chats.view') ? [link('dashboard', 'home', 'Overview'), link('inbox', 'inbox', 'Inbox')] : null,
      can('contacts.view') || can('chats.view') ? h('div', { class: 'sec' }, 'People') : null, can('contacts.view') ? link('contacts', 'users', 'Contacts') : null, can('chats.view') ? link('visitors', 'eye', 'Live visitors') : null,
      can('bot.manage') ? [h('div', { class: 'sec' }, 'Automation'), link('bot', 'bot', 'Chatbot & flows'), link('triggers', 'zap', 'Triggers')] : null,
      h('div', { class: 'sec' }, 'Workspace'), link('settings', 'cog', 'Settings'),
      h('a', { onclick: () => { setTheme(dark ? 'light' : 'dark'); renderShell(); } }, icon(dark ? 'sun' : 'moon'), h('span', { class: 'lbl' }, dark ? 'Light mode' : 'Dark mode')),
      h('div', { class: 'me' }, avEl({ id: S.me.email, name: S.me.name }), h('div', {}, h('b', {}, S.me.name), h('small', {}, S.role.name)),
        h('button', { title: 'Sign out', onclick: async () => { await api('/auth/logout', 'POST'); S.me = null; renderLogin(); } }, icon('logout')))),
    main));
  if (!can('chats.view') && ['dashboard', 'inbox', 'visitors'].includes(S.view)) S.view = can('contacts.view') ? 'contacts' : 'settings';
  (views[S.view] || renderSettings)(main);
}
const refreshNavBadge = () => { const a = document.querySelector('.nav a[data-v=inbox]'); if (!a) return; a.querySelector('.cnt')?.remove(); if (totalUnread()) a.append(h('span', { class: 'cnt' }, totalUnread())); };

// ---------- realtime ----------
/** Re-reads my access after a reconnect: roles, websites or membership may have changed. */
async function checkAccess() {
  const d = await api('/me').catch(() => null); if (!d?.user) return;
  const sig = x => JSON.stringify([x.workspace?.id, [...(x.permissions || x.perms || [])].sort(), (x.sites || []).map(s => s.id)]);
  if (sig(d) !== sig({ workspace: S.workspace, permissions: [...S.perms], sites: S.sites })) { toast('Your access was updated'); boot(); }
}
function connect() {
  if (es) es.close();
  es = new EventSource('/api/events');
  let first = true;
  es.addEventListener('ready', () => { if (!first) checkAccess(); first = false; if (S.view === 'inbox') loadConvs(); });
  es.onerror = debounce(checkAccess, 3000);
  es.addEventListener('message', e => {
    const { conv, message } = JSON.parse(e.data);
    S.convs.set(conv.id, conv);
    if (S.cur === conv.id) {
      if (!S.msgs.some(m => m.id === message.id)) S.msgs.push(message);
      if (message.sender === 'visitor' && document.hasFocus()) { api(`/conversations/${conv.id}/read`, 'POST').catch(() => {}); conv.unread = 0; }
      S.typing[conv.visitor.id] = 0;
      if (S.view === 'inbox') { drawMessages(); drawList(); drawSide(); }
    } else if (S.view === 'inbox') drawList();
    if (message.sender === 'visitor' && (S.cur !== conv.id || !document.hasFocus())) {
      beep();
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(vname(conv.visitor), { body: message.body });
    }
    refreshNavBadge();
  });
  es.addEventListener('conversation', e => {
    const c = JSON.parse(e.data); S.convs.set(c.id, c);
    if (S.view === 'inbox') { drawList(); if (S.cur === c.id) { drawHead(); drawSide(); const tb = document.getElementById('tagbar'); if (tb && !tb.contains(document.activeElement)) drawTags(); } }
    refreshNavBadge();
  });
  es.addEventListener('deleted', e => { const { id } = JSON.parse(e.data); S.convs.delete(id); if (S.cur === id) { S.cur = null; } if (S.view === 'inbox') renderShell(); });
  es.addEventListener('presence', e => {
    const p = JSON.parse(e.data);
    if (p.online) S.visitors.set(p.visitor_id, p.visitor); else S.visitors.delete(p.visitor_id);
    for (const c of S.convs.values()) if (c.visitor.id === p.visitor_id) { c.visitor.online = p.online; if (p.visitor) Object.assign(c.visitor, p.visitor, { online: p.online }); }
    if (S.view === 'inbox') { drawList(); drawSide(); drawHead(); } else if (S.view === 'visitors') drawVisitors();
  });
  es.addEventListener('typing', e => {
    const { visitor_id } = JSON.parse(e.data); S.typing[visitor_id] = Date.now();
    if (S.view === 'inbox') drawTyping();
    setTimeout(() => S.view === 'inbox' && drawTyping(), 3100);
  });
}

// ---------- inbox ----------
async function loadConvs() {
  const p = new URLSearchParams();
  if (S.filter === 'closed') p.set('status', 'closed'); else { p.set('status', 'open'); if (S.filter !== 'open') p.set('filter', S.filter); }
  if (S.q) p.set('q', S.q);
  if (S.tag) p.set('tag', S.tag);
  const d = await api('/conversations?' + p);
  S.convs = new Map(d.conversations.map(c => [c.id, c]));
  drawList(); refreshNavBadge();
}
function visibleConvs() {
  return [...S.convs.values()].filter(c => {
    if (S.tag && !(c.tags || []).includes(S.tag)) return false;
    if (S.filter === 'closed') return c.status === 'closed';
    if (c.status !== 'open') return false;
    if (S.filter === 'mine') return c.assignee_id === S.me.id;
    if (S.filter === 'unassigned') return !c.assignee_id;
    if (S.filter === 'human') return c.needs_human;
    return true;
  }).sort((a, b) => (b.needs_human - a.needs_human) || b.updated - a.updated);
}
function renderInbox(main) {
  api('/tags').then(d => { const changed = JSON.stringify(d.tags) !== JSON.stringify(S.tags); S.tags = d.tags; if (changed && S.view === 'inbox' && !document.querySelector('.filters + .filters') && S.tags.length) renderShell(); }).catch(() => {});
  main.append(h('div', { class: 'inbox' },
    h('div', { class: 'list' },
      h('div', { class: 'top' },
        h('input', { placeholder: 'Search conversations…', value: S.q, oninput: debounce(e => { S.q = e.target.value; loadConvs(); }, 250) }),
        h('div', { class: 'filters' }, ...[['open', 'All open'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['human', 'Needs human'], ['closed', 'Closed']]
          .map(([k, l]) => h('button', { class: S.filter === k ? 'on' : '', onclick: () => { S.filter = k; renderShell(); } }, l))),
        S.tags.length ? h('div', { class: 'filters' }, h('span', { class: 'hint', style: 'margin:0 4px 0 0' }, 'Tags:'), ...S.tags.slice(0, 8).map(t => h('button', { class: S.tag === t.name ? 'on' : '', onclick: () => { S.tag = S.tag === t.name ? '' : t.name; renderShell(); } }, `${t.name} ${t.count}`))) : null),
      h('div', { class: 'items', id: 'items' })),
    h('div', { class: 'chat', id: 'chat' }), h('div', { class: 'side', id: 'side' })));
  loadConvs().then(() => { if (S.cur && S.convs.has(S.cur)) openConv(S.cur); else drawChatEmpty(); });
  drawSide();
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function drawList() {
  const box = document.getElementById('items'); if (!box) return;
  const list = visibleConvs();
  box.replaceChildren(...(list.length ? list.map(c => h('div', { class: 'item' + (c.id === S.cur ? ' on' : '') + (c.unread ? ' unr' : ''), onclick: () => openConv(c.id) },
    avEl(c.visitor, c.visitor.online ? h('span', { class: 'on-dot' }) : null),
    h('div', { style: 'min-width:0;flex:1' },
      h('div', { class: 'nm' }, vname(c.visitor), c.needs_human ? h('span', { class: 'pill bad' }, 'human') : null, c.unread ? h('span', { class: 'unread' }, c.unread) : null, h('span', { class: 't' }, ago(c.updated))),
      h('div', { class: 'lb' }, c.last_body || '…'), S.sites.length > 1 && !S.site ? h('div', { class: 'hint', style: 'margin:1px 0 0;font-size:11.5px' }, '🌐 ' + (c.site_name || '')) : null,
      h('div', { class: 'row', style: 'gap:5px;margin-top:3px;flex-wrap:wrap' }, ...(c.tags || []).slice(0, 3).map(t => h('span', { class: 'tag' }, t)), c.assignee_name ? h('span', { class: 'hint', style: 'margin:0' }, '→ ' + c.assignee_name) : null)))) : [h('div', { class: 'empty' }, h('div', { class: 'big' }, '🎉'), 'No conversations here')]));
}
function drawChatEmpty() { const c = document.getElementById('chat'); if (c) c.replaceChildren(h('div', { class: 'empty' }, h('div', { style: 'font-size:40px' }, '💬'), 'Select a conversation')); drawSide(); }
async function openConv(id) {
  S.cur = id;
  const d = await api('/conversations/' + id);
  S.convs.set(id, d.conversation); S.msgs = d.messages;
  if (d.conversation.unread) { api(`/conversations/${id}/read`, 'POST').catch(() => {}); d.conversation.unread = 0; refreshNavBadge(); }
  const chat = document.getElementById('chat'); if (!chat) return;
  const ta = h('textarea', { placeholder: 'Type a message…  (type / for saved replies)' });
  const menu = h('div', { class: 'canned', style: 'display:none' });
  let sel = 0, opts = [];
  const closeMenu = () => { menu.style.display = 'none'; opts = []; };
  const drawMenu = () => menu.replaceChildren(...opts.map((c, i) => h('div', { class: i === sel ? 'on' : '', onmousedown: e => { e.preventDefault(); pick(c); } }, h('b', {}, '/' + c.shortcut), ' ' + c.text.slice(0, 80))));
  const pick = c => { ta.value = c.text; closeMenu(); ta.focus(); };
  ta.addEventListener('input', () => {
    const m = S.mode === 'reply' && ta.value.match(/^\/(\w*)$/);
    if (m) { opts = S.canned.filter(c => c.shortcut.startsWith(m[1].toLowerCase())); sel = 0; menu.style.display = opts.length ? 'block' : 'none'; drawMenu(); } else closeMenu();
    if (S.mode === 'reply' && Date.now() - (ta._t || 0) > 2500 && ta.value) { ta._t = Date.now(); api(`/conversations/${S.cur}/typing`, 'POST', {}).catch(() => {}); }
  });
  ta.addEventListener('keydown', e => {
    if (opts.length) {
      if (e.key === 'ArrowDown') { sel = (sel + 1) % opts.length; drawMenu(); return e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = (sel - 1 + opts.length) % opts.length; drawMenu(); return e.preventDefault(); }
      if (e.key === 'Enter' || e.key === 'Tab') { pick(opts[sel]); return e.preventDefault(); }
      if (e.key === 'Escape') return closeMenu();
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  const send = guard(async () => {
    const body = ta.value.trim(); if (!body) return;
    ta.value = '';
    await api(`/conversations/${S.cur}/${S.mode === 'note' ? 'note' : 'messages'}`, 'POST', { body });
  });
  const fileIn = h('input', { type: 'file', style: 'display:none', accept: 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain', onchange: guard(async () => {
    const f = fileIn.files[0]; fileIn.value = ''; if (!f) return;
    if (f.size > 3e6) throw new Error('File too large (max 3 MB)');
    const data = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(f); });
    await api(`/conversations/${S.cur}/upload`, 'POST', { name: f.name, type: f.type, data });
  }) });
  const modeBtn = (m, l, cls) => h('button', { class: (S.mode === m ? 'on ' : '') + cls, onclick: e => { S.mode = m; ta.placeholder = m === 'note' ? 'Internal note — only your team sees this' : 'Type a message…  (type / for saved replies)'; e.target.parentNode.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.target.classList.add('on'); } }, l);
  chat.replaceChildren(h('div', { class: 'hd', id: 'hd' }), h('div', { class: 'tagbar', id: 'tagbar' }), h('div', { class: 'msgs', id: 'msgs' }), h('div', { class: 'typing', id: 'typing' }),
    !can('chats.reply') ? h('div', { class: 'composer hint', style: 'text-align:center;padding:16px' }, '👁 Read-only — your role can view conversations but not reply.') : h('div', { class: 'composer' }, menu, h('div', { class: 'modes' }, modeBtn('reply', 'Reply', ''), modeBtn('note', 'Internal note', 'note')), ta,
      h('div', { class: 'row', style: 'margin-top:6px;justify-content:space-between' }, h('span', { class: 'row hint' }, fileIn, h('button', { class: 'btn sec sm', onclick: () => fileIn.click() }, icon('clip', 14), 'Attach'), h('button', { class: 'btn sec sm', onclick: e => toggleEmoji(e.currentTarget, ta) }, icon('smile', 14), 'Emoji'), ' Enter to send · Shift+Enter for newline'), h('button', { class: 'btn', onclick: send }, 'Send'))));
  drawHead(); drawTags(); drawMessages(); drawSide(); drawList(); ta.focus();
}
function drawHead() {
  const hd = document.getElementById('hd'), c = S.convs.get(S.cur); if (!hd || !c) return;
  const assign = h('select', { disabled: !can('chats.assign'), title: can('chats.assign') ? 'Assign' : 'You cannot reassign chats', onchange: guard(async e => { await api(`/conversations/${c.id}/assign`, 'POST', { agent_id: e.target.value ? +e.target.value : null }); }) },
    h('option', { value: '' }, 'Unassigned'), ...S.members.filter(a => a.can_reply && (!a.site_ids || a.site_ids.includes(c.site_id)) || a.id === c.assignee_id).map(a => h('option', { value: a.id, selected: a.id === c.assignee_id }, a.name)));
  hd.replaceChildren(avEl(c.visitor), h('div', { class: 'grow', style: 'flex:1' }, h('b', {}, vname(c.visitor)),
    h('div', { class: 'hint' }, c.visitor.online ? '🟢 online' : 'offline', c.bot_active ? ' · 🤖 bot handling' : '')), assign,
    can('chats.close') ? h('button', { class: 'btn sec', onclick: guard(() => api(`/conversations/${c.id}/status`, 'POST', { status: c.status === 'open' ? 'closed' : 'open' })) }, c.status === 'open' ? '✓ Close' : 'Reopen') : null,
    h('a', { class: 'btn sec', href: `/api/conversations/${c.id}/transcript`, title: 'Download transcript', style: 'text-decoration:none' }, icon('download')),
    can('chats.delete') ? h('button', { class: 'btn danger', title: 'Delete conversation', onclick: guard(async () => { if (confirm('Delete this conversation permanently?')) await api('/conversations/' + c.id, 'DELETE'); }) }, icon('trash')) : null);
}
const EMOJI = [...'😀😃😄😁😆😅😂🤣😊😇🙂😉😍🥰😘😋😎🤩🥳🤔🙄😬😢😭😡👍👎👏🙌🙏💪👋🔥❤️💜🎉✨💯✅❌⭐🚀'.matchAll(/\p{Extended_Pictographic}\uFE0F?/gu)].map(m => m[0]);
function toggleEmoji(btn, ta) {
  const old = document.querySelector('.emo'); if (old) return old.remove();
  const box = h('div', { class: 'emo' }, ...EMOJI.map(e => h('button', { onclick: () => { ta.value += e; ta.focus(); } }, e)));
  btn.closest('.composer').append(box);
}
function drawTags() {
  const bar = document.getElementById('tagbar'), c = S.convs.get(S.cur); if (!bar || !c) return;
  const save = guard(async tags => { await api(`/conversations/${c.id}/tags`, 'POST', { tags }); api('/tags').then(d => { S.tags = d.tags; }); });
  if (!can('chats.reply')) return bar.replaceChildren(h('span', { class: 'hint', style: 'margin:0' }, 'Tags'), ...(c.tags || []).map(t => h('span', { class: 'tag' }, t)));
  const inp = h('input', { placeholder: '+ add tag', list: 'taglist', onkeydown: e => { if (e.key === 'Enter' && inp.value.trim()) { save([...(c.tags || []), inp.value.trim()]); inp.value = ''; } } });
  bar.replaceChildren(h('span', { class: 'hint', style: 'margin:0' }, 'Tags'), ...(c.tags || []).map(t => h('span', { class: 'tag' }, t, h('button', { title: 'Remove', onclick: () => save(c.tags.filter(x => x !== t)) }, '×'))), inp,
    h('datalist', { id: 'taglist' }, ...S.tags.map(t => h('option', { value: t.name }))));
}
function drawMessages() {
  const box = document.getElementById('msgs'); if (!box) return;
  const out = []; let prev = null, day = '';
  for (const m of S.msgs) {
    const d = new Date(m.created).toDateString(); if (d !== day) { day = d; out.push(h('div', { class: 'daysep' }, d === new Date().toDateString() ? 'Today' : d)); prev = null; }
    if (m.sender === 'system') { out.push(h('div', { class: 'sysmsg' }, m.body)); prev = null; continue; }
    const key = m.sender + (m.sender_name || '');
    if (key !== prev) out.push(h('div', { class: 'meta' + (m.sender === 'visitor' ? '' : ' r') }, (m.sender === 'visitor' ? vname(S.convs.get(S.cur)?.visitor) : m.sender_name || m.sender) + (m.sender === 'note' ? ' (note)' : '') + ' · ' + new Date(m.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    const att = m.attachment;
    out.push(h('div', { class: 'msg ' + m.sender }, att ? (/^image\//.test(att.type) ? h('a', { href: att.url, target: '_blank', rel: 'noopener' }, h('img', { src: att.url, alt: att.name, style: 'max-width:240px;border-radius:8px;display:block' })) : h('a', { href: att.url, target: '_blank', rel: 'noopener', style: 'color:inherit' }, '📎 ' + att.name)) : m.body)); prev = key;
  }
  box.replaceChildren(...out); box.scrollTop = box.scrollHeight; drawTyping();
}
function drawTyping() {
  const t = document.getElementById('typing'), c = S.convs.get(S.cur); if (!t || !c) return;
  t.textContent = Date.now() - (S.typing[c.visitor.id] || 0) < 3000 ? vname(c.visitor) + ' is typing…' : '';
}
function drawSide() {
  const side = document.getElementById('side'); if (!side) return;
  const c = S.convs.get(S.cur);
  if (!c) return side.replaceChildren(h('div', { class: 'empty' }, 'Visitor details appear here'));
  const v = c.visitor;
  const dl = (t, val) => val ? [h('dt', {}, t), h('dd', {}, val)] : [];
  side.replaceChildren(h('h4', {}, 'Visitor'), h('dl', {}, dl('Name', v.name), dl('Email', v.email && h('a', { href: 'mailto:' + v.email }, v.email)), dl('Status', v.online ? 'Online' : 'Offline'),
    dl('Current page', v.page), dl('Visits', String(v.visits)), dl('First seen', new Date(v.created).toLocaleString()), dl('Browser', v.ua?.slice(0, 90))),
    h('h4', {}, 'Conversation'), h('dl', {}, dl('Status', c.status), dl('Started', new Date(c.created).toLocaleString()), dl('Assignee', c.assignee_name || 'Unassigned'), dl('Handled by', c.bot_active ? 'Bot' : 'Human')));
}

// ---------- visitors ----------
// ---------- contacts ----------
async function renderContacts(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const box = h('div', { class: 'card', style: 'padding:0' });
  const load = guard(async q => {
    const { contacts } = await api('/contacts?q=' + encodeURIComponent(q || ''));
    box.replaceChildren(contacts.length ? h('table', {}, h('thead', {}, h('tr', {}, ...['Contact', 'Email', 'Chats', 'Visits', 'Last seen'].map(x => h('th', {}, x)))),
      h('tbody', {}, ...contacts.map(c => h('tr', { style: 'cursor:pointer', onclick: () => openContact(c.id) }, h('td', {}, h('div', { class: 'row' }, avEl(c), h('b', {}, vname(c)), c.online ? h('span', { class: 'pill ok' }, 'online') : null)),
        h('td', {}, c.email || '—'), h('td', {}, c.conversations), h('td', {}, c.visits), h('td', {}, ago(c.last_seen) + ' ago')))))
      : h('div', { class: 'empty' }, h('div', { class: 'big' }, '👥'), 'No contacts yet. Visitors appear here once they share a name or email.'));
  });
  page.append(h('div', { class: 'row', style: 'margin-bottom:18px' }, h('h2', { class: 'page-h grow', style: 'margin:0' }, 'Contacts'),
    h('input', { placeholder: 'Search name or email…', style: 'width:260px', oninput: debounce(e => load(e.target.value), 250) }),
    h('a', { class: 'btn sec', href: '/api/export/contacts.csv', style: 'text-decoration:none' }, icon('download', 16), 'Export CSV')), box);
  load('');
}
const openContact = guard(async id => {
  const { contact: c, conversations } = await api('/contacts/' + id);
  const f = { name: h('input', { value: c.name || '' }), email: h('input', { type: 'email', value: c.email || '' }), notes: h('textarea', { rows: 4, placeholder: 'Private notes about this contact…' }, c.notes || '') };
  const d = h('div', { class: 'drawer' }, h('div', { class: 'row' }, avEl(c), h('div', { class: 'grow' }, h('h3', { style: 'margin:0' }, vname(c)), h('div', { class: 'hint', style: 'margin:0' }, `${c.visits} visits · first seen ${new Date(c.created).toLocaleDateString()}`)),
    h('button', { class: 'btn sec sm', onclick: () => d.remove() }, '✕')),
    h('label', {}, 'Name'), f.name, h('label', {}, 'Email'), f.email, h('label', {}, 'Notes'), f.notes,
    h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: guard(async () => { await api('/contacts/' + id, 'PUT', { name: f.name.value, email: f.email.value, notes: f.notes.value }); toast('Contact saved'); d.remove(); if (S.view === 'contacts') renderShell(); }) }, 'Save'),
      c.email ? h('a', { class: 'btn sec', href: 'mailto:' + c.email, style: 'text-decoration:none' }, 'Email') : null),
    h('h4', { style: 'margin:24px 0 8px;font-size:12px;text-transform:uppercase;color:var(--mut)' }, `Conversations (${conversations.length})`),
    ...conversations.map(cv => h('div', { class: 'check', style: 'cursor:pointer', onclick: () => { d.remove(); S.cur = cv.id; S.view = 'inbox'; S.filter = cv.status === 'open' ? 'open' : 'closed'; renderShell(); } },
      h('div', { class: 'grow', style: 'flex:1;min-width:0' }, h('b', {}, cv.last_body || '(no messages)'), h('div', { class: 'hint', style: 'margin:0' }, `${cv.status} · ${new Date(cv.updated).toLocaleString()}`)), ...(cv.tags || []).map(t => h('span', { class: 'tag' }, t)))));
  document.querySelector('.drawer')?.remove(); document.body.append(d);
});

// ---------- triggers ----------
async function renderTriggers(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const admin = can('bot.manage'), { triggers } = await api('/triggers');
  page.append(h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h2', { class: 'page-h grow', style: 'margin:0' }, 'Triggers'), admin ? h('button', { class: 'btn', onclick: () => triggerEditor(null) }, icon('plus', 16), 'New trigger') : null),
    siteBar(), h('p', { class: 'hint', style: 'margin:0 0 18px' }, 'Start the conversation for visitors: show a message after a delay on pages whose URL contains some text, or open the chat automatically.'),
    ...(triggers.length ? triggers.map(t => h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, t.name), ' ', h('span', { class: 'pill' + (t.enabled ? ' ok' : '') }, t.enabled ? 'active' : 'paused'), t.open_chat ? h('span', { class: 'pill warn' }, 'auto-opens chat') : null,
      h('div', { class: 'hint' }, `Page URL ${t.url_contains ? 'contains "' + t.url_contains + '"' : 'any page'} · after ${t.delay}s`), h('div', { style: 'margin-top:6px' }, '💬 ' + t.message)),
      admin ? [h('button', { class: 'btn sec sm', onclick: () => triggerEditor(t) }, 'Edit'), h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm('Delete trigger?')) { await api('/triggers/' + t.id, 'DELETE'); renderShell(); } }) }, 'Delete')] : null)))
      : [h('div', { class: 'card empty' }, h('div', { class: 'big' }, '⚡'), 'No triggers yet')]));
}
function triggerEditor(t) {
  const f = { name: h('input', { value: t?.name || '', placeholder: 'e.g. Pricing page help' }), url: h('input', { value: t?.url_contains || '', placeholder: '/pricing   (leave empty for every page)' }), delay: h('input', { type: 'number', min: 0, max: 600, value: t?.delay ?? 10 }),
    message: h('textarea', { rows: 3 }, t?.message || ''), open: h('input', { type: 'checkbox', checked: !!t?.open_chat }), en: h('input', { type: 'checkbox', checked: t ? t.enabled : true }) };
  const m = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:480px;max-width:96vw' }, h('h3', {}, t ? 'Edit trigger' : 'New trigger'),
    h('label', {}, 'Name'), f.name, h('label', {}, 'Page URL contains'), f.url, h('label', {}, 'Delay (seconds)'), f.delay, h('label', {}, 'Message'), f.message,
    h('label', { class: 'inline' }, f.open, 'Open the chat window automatically (instead of a bubble)'), h('label', { class: 'inline' }, f.en, 'Active'),
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px' }, h('button', { class: 'btn sec', onclick: () => m.remove() }, 'Cancel'),
      h('button', { class: 'btn', onclick: guard(async () => {
        const b = { name: f.name.value, url_contains: f.url.value, delay: +f.delay.value, message: f.message.value, open_chat: f.open.checked, enabled: f.en.checked };
        await (t ? api('/triggers/' + t.id, 'PUT', b) : api('/triggers', 'POST', b)); m.remove(); renderShell();
      }) }, 'Save'))));
  document.body.append(m);
}

async function renderVisitors(main) {
  main.append(h('div', { class: 'page' }, h('div', { class: 'row', style: 'margin-bottom:16px' }, h('h2', { class: 'page-h grow', style: 'margin:0' }, 'Live visitors')), h('div', { class: 'card', id: 'vis', style: 'padding:0' })));
  const d = await api('/visitors'); S.visitors = new Map(d.visitors.map(v => [v.id, v])); drawVisitors();
}
function drawVisitors() {
  const box = document.getElementById('vis'); if (!box) return;
  const list = [...S.visitors.values()];
  box.replaceChildren(list.length ? h('table', {}, h('thead', {}, h('tr', {}, ...['Visitor', 'Page', 'Visits', 'Last seen', ''].map(x => h('th', {}, x)))),
    h('tbody', {}, ...list.map(v => h('tr', {}, h('td', {}, vname(v)), h('td', {}, v.page || '—'), h('td', {}, v.visits), h('td', {}, ago(v.last_seen)),
      h('td', {}, h('button', { class: 'btn sm sec', onclick: guard(async () => {
        const all = (await api('/conversations?status=open')).conversations.find(c => c.visitor.id === v.id);
        if (all) { S.cur = all.id; S.view = 'inbox'; S.filter = 'open'; renderShell(); } else toast('This visitor has not started a chat yet');
      }) }, 'Open chat'))))))
    : h('div', { class: 'empty', style: 'padding:30px' }, 'Nobody is on your site right now. Open the demo page to see yourself here.'));
}

// ---------- overview ----------
async function renderDashboard(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const safe = p => api(p).catch(() => null);
  const [s, an, kb] = await Promise.all([api('/stats'), can('analytics.view') ? safe('/analytics') : null, safe('/kb')]);
  const stat = (ic, n, l, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'ico' }, icon(ic)), h('div', {}, h('b', {}, n), h('span', {}, l)));
  const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const steps = can('settings.manage') ? [
    ['Install the widget on your website', 'Settings → Websites has the snippet for each site', s.today + s.open + s.resolved + s.visitorsOnline > 0],
    ['Receive your first conversation', 'Open your site (or the demo page) and say hello', s.open + s.resolved > 0],
    ['Teach the bot with your FAQ', 'Chatbot & flows → Knowledge base', (kb?.kb.length || 0) > 2],
    ['Invite a teammate', 'Settings → Team', S.members.length > 1],
    ['Add another website', 'Settings → Websites', S.sites.length > 1],
  ] : [];
  const done = steps.filter(x => x[2]).length;
  const siteName = S.site ? S.sites.find(x => x.id === S.site)?.name : S.sites.length > 1 ? 'all websites' : S.sites[0]?.name;
  page.append(h('h2', {}, `${greet}, ${S.me.name.split(' ')[0]} 👋`), h('p', { class: 'hint', style: 'margin:-10px 0 18px' }, `${S.workspace.name} · ${siteName} · you are ${S.role.name}`),
    h('div', { class: 'grid' }, stat('msg', s.open, 'Open conversations'), stat('alert', s.needsHuman, 'Waiting for a human', s.needsHuman ? 'warn' : ''), stat('inbox', s.unassigned, 'Unassigned'), stat('eye', s.visitorsOnline, 'Visitors online'),
      stat('zap', s.today, 'New chats today'), stat('send', s.messagesToday, 'Messages today'), stat('check', s.resolved, 'Resolved total', 'ok'), stat('users', s.agentsOnline, 'Teammates online')),
    steps.length && done < steps.length ? h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Getting started'), h('span', { class: 'hint' }, `${done} of ${steps.length} done`)),
      h('div', { class: 'progress' }, h('div', { style: `width:${done / steps.length * 100}%` })),
      ...steps.map(([t, d, ok]) => h('div', { class: 'check' + (ok ? ' done' : '') }, h('div', { class: 'c' }, ok ? icon('check', 14) : null), h('div', {}, h('b', {}, t), h('div', { class: 'hint', style: 'margin:0' }, d))))) : null,
    an ? (() => { const max = Math.max(1, ...an.days.map(d => d.chats)); return h('div', { class: 'card' }, h('h3', {}, 'Conversations — last 14 days'),
      h('div', { style: 'display:flex;align-items:flex-end;gap:7px;height:130px;margin:16px 0 4px' }, ...an.days.map(d => h('div', { title: `${d.date}: ${d.chats} chats, ${d.messages} messages`, style: `flex:1;background:linear-gradient(180deg,var(--pri2),var(--pri));border-radius:5px 5px 0 0;opacity:${d.chats ? 1 : .25};height:${Math.max(3, d.chats / max * 100)}%` }))),
      h('div', { class: 'row hint', style: 'justify-content:space-between' }, h('span', {}, an.days[0].date), h('span', {}, an.days[13].date)),
      h('div', { class: 'grid', style: 'margin:16px 0 0' }, stat('clock', an.avgFirstResponseSec == null ? '—' : an.avgFirstResponseSec < 90 ? an.avgFirstResponseSec + 's' : Math.round(an.avgFirstResponseSec / 60) + 'm', 'Avg first response'),
        stat('star', an.csat == null ? '—' : an.csat + ' / 5', `Satisfaction (${an.ratings} ratings)`), stat('bot', an.botHandledPct + '%', 'Handled by bot only'), stat('users', an.contacts, 'Contacts with email')),
      an.agents.length ? [h('h3', { style: 'margin-top:18px' }, 'Team performance'), h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Teammate'), h('th', {}, 'Chats handled'), h('th', {}, 'Satisfaction'))),
        h('tbody', {}, ...an.agents.map(a => h('tr', {}, h('td', {}, h('div', { class: 'row' }, avEl({ id: a.name, name: a.name }), a.name)), h('td', {}, a.chats), h('td', {}, a.csat == null ? '—' : a.csat + ' / 5')))))] : null); })() : null);
}
const snippet = (site = S.sites.find(x => x.id === cfgSite())) => `<script src="${location.origin}/widget.js" data-key="${site?.site_key}" async></script>`;
/** Website picker shown on pages that configure a single site. */
const siteBar = () => S.sites.length > 1 ? h('div', { class: 'row', style: 'margin:-6px 0 18px' }, h('span', { class: 'hint', style: 'margin:0' }, 'Website:'),
  h('select', { style: 'width:auto', onchange: e => { S.site = +e.target.value; renderShell(); } }, ...S.sites.map(x => h('option', { value: x.id, selected: x.id === cfgSite() }, x.name)))) : null;

// ---------- chatbot ----------
async function renderBot(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const [{ rules }, { settings }, { kb }, { flows }] = await Promise.all([api('/rules'), api('/settings'), api('/kb'), api('/flows')]);
  const admin = can('bot.manage');
  page.append(h('h2', {}, 'Chatbot & flows'), siteBar(),
    h('div', { class: 'card' }, h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: settings.botEnabled, disabled: !admin, onchange: guard(async e => { await api('/settings', 'PUT', { botEnabled: e.target.checked }); toast('Saved'); }) }), 'Enable chatbot for new conversations'),
      h('div', { class: 'hint' }, 'The bot answers with the first rule that matches, and hands over to a human on request. As soon as an agent replies, the bot stops.'),
      h('label', {}, 'Try it'), h('div', { class: 'row' }, h('input', { id: 'bt', placeholder: 'Type a visitor message to test the rules…', class: 'grow' }),
        h('button', { class: 'btn sec', onclick: guard(async () => { const { rule } = await api('/bot/test', 'POST', { text: document.getElementById('bt').value }); document.getElementById('btr').textContent = rule ? `✓ "${rule.name}" → ${rule.reply}` : '✗ No rule matches — fallback message is sent'; }) }, 'Test')), h('div', { class: 'hint', id: 'btr' })),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow', style: 'margin:0' }, 'Flows'), admin ? h('button', { class: 'btn', onclick: () => flowEditor(null) }, '+ New flow') : null),
      h('div', { class: 'hint' }, 'Guided conversations: the bot asks questions, offers choices, captures name/email and can hand over to a human. A flow starts when its keywords match and takes priority over simple rules.'),
      ...flows.map(f => h('div', { class: 'row', style: 'padding:10px 0;border-top:1px solid var(--bd)' }, h('div', { class: 'grow' }, h('b', {}, f.name), ' ', f.enabled ? null : h('span', { class: 'pill' }, 'disabled'),
        h('div', { class: 'hint' }, `Keywords: ${f.keywords} · ${f.nodes.length} steps`)),
        admin ? [h('button', { class: 'btn sec sm', onclick: () => flowEditor(f) }, 'Edit'), h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm('Delete flow?')) { await api('/flows/' + f.id, 'DELETE'); renderShell(); } }) }, 'Delete')] : null))),
    h('div', { class: 'card' }, h('h3', {}, 'AI answers'),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: settings.aiEnabled, disabled: !admin, onchange: guard(async e => { await api('/settings', 'PUT', { aiEnabled: e.target.checked }); toast('Saved'); }) }), 'Use Claude to answer from the knowledge base when no rule matches'),
      h('div', { class: 'hint' }, S.aiConfigured ? '✓ ANTHROPIC_API_KEY is configured on the server.' : 'Set the ANTHROPIC_API_KEY environment variable on the server to enable this. Without it, the knowledge base still answers by keyword matching.'),
      h('label', {}, 'Assistant instructions'), h('textarea', { rows: 2, id: 'aiins', disabled: !admin }, settings.aiInstructions),
      admin ? h('button', { class: 'btn sec sm', style: 'margin-top:6px', onclick: guard(async () => { await api('/settings', 'PUT', { aiInstructions: document.getElementById('aiins').value }); toast('Saved'); }) }, 'Save instructions') : null),
    h('div', { class: 'card' }, h('h3', {}, 'Knowledge base'), h('div', { class: 'hint' }, 'Question & answer pairs the bot uses when no rule matches (and that the AI answers from).'),
      ...kb.map(e => h('div', { class: 'row', style: 'padding:8px 0;border-bottom:1px solid var(--bd)' }, h('div', { class: 'grow' }, h('b', {}, e.question), h('div', {}, e.answer)),
        admin ? h('button', { class: 'btn danger sm', onclick: guard(async () => { await api('/kb/' + e.id, 'DELETE'); renderShell(); }) }, 'Delete') : null)),
      admin ? h('div', { style: 'margin-top:12px' }, h('input', { id: 'kbq', placeholder: 'Question, e.g. Do you ship internationally?' }), h('textarea', { id: 'kba', rows: 2, placeholder: 'Answer', style: 'margin-top:6px' }),
        h('button', { class: 'btn sm', style: 'margin-top:6px', onclick: guard(async () => { await api('/kb', 'POST', { question: document.getElementById('kbq').value, answer: document.getElementById('kba').value }); renderShell(); }) }, 'Add entry')) : null),
    h('div', { class: 'row', style: 'margin-bottom:10px' }, h('h3', { class: 'grow', style: 'margin:0' }, 'Rules'), admin ? h('button', { class: 'btn', onclick: () => ruleEditor(main, null) }, '+ New rule') : null),
    ...rules.map(r => h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, r.name), ' ', r.handoff ? h('span', { class: 'pill warn' }, 'hands off to human') : null, r.enabled ? null : h('span', { class: 'pill' }, 'disabled'),
      h('div', { class: 'hint' }, 'Keywords: ' + r.keywords), h('div', {}, '💬 ' + r.reply), r.buttons.length ? h('div', { class: 'hint' }, 'Buttons: ' + r.buttons.join(' · ')) : null),
      admin ? [h('button', { class: 'btn sec sm', onclick: () => ruleEditor(main, r) }, 'Edit'), h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm('Delete rule?')) { await api('/rules/' + r.id, 'DELETE'); renderShell(); } }) }, 'Delete')] : null))));
}
function flowEditor(f) {
  const st = { name: f?.name || '', keywords: f?.keywords || '', enabled: f ? f.enabled : true,
    nodes: f ? JSON.parse(JSON.stringify(f.nodes)) : [{ id: 'n1', type: 'message', text: 'Hi! Let me help you with that.', next: '' }] };
  const body = h('div'); const err = h('div', { class: 'err' });
  const nextSel = (val, onch) => h('select', { onchange: e => onch(e.target.value) }, h('option', { value: '' }, '— end of flow —'), ...st.nodes.map(n => h('option', { value: n.id, selected: n.id === val }, n.id)));
  const draw = () => {
    body.replaceChildren(...st.nodes.map((n, i) => h('div', { style: 'border:1px solid var(--bd);border-radius:10px;padding:10px;margin-top:10px;background:#fafafa' },
      h('div', { class: 'row' }, h('span', { class: 'pill' }, '#' + (i + 1)),
        h('input', { value: n.id, style: 'width:90px', title: 'Step id', onchange: e => { const old = n.id, nv = e.target.value.trim(); st.nodes.forEach(x => { if (x.next === old) x.next = nv; (x.options || []).forEach(o => { if (o.next === old) o.next = nv; }); }); n.id = nv; draw(); } }),
        h('select', { style: 'width:auto', onchange: e => { n.type = e.target.value; if (n.type === 'choice' && !n.options) n.options = [{ label: 'Option 1', next: '' }]; if (n.type === 'ask' && !n.field) n.field = 'name'; draw(); } },
          ...[['message', 'Send message'], ['choice', 'Ask to choose'], ['ask', 'Ask a question'], ['handoff', 'Hand over to human'], ['end', 'End flow']].map(([v, l]) => h('option', { value: v, selected: n.type === v }, l))),
        h('span', { class: 'grow' }), h('button', { class: 'btn danger sm', disabled: st.nodes.length === 1, onclick: () => { st.nodes.splice(i, 1); draw(); } }, '✕')),
      n.type !== 'end' ? h('textarea', { rows: 2, style: 'margin-top:6px', placeholder: 'What the bot says', oninput: e => { n.text = e.target.value; } }, n.text || '') : null,
      n.type === 'ask' ? h('div', { class: 'row', style: 'margin-top:6px' }, 'Save answer as', h('select', { style: 'width:auto', onchange: e => { n.field = e.target.value; } }, ...['name', 'email', 'phone', 'text'].map(v => h('option', { value: v, selected: n.field === v }, v)))) : null,
      n.type === 'message' || n.type === 'ask' ? h('div', { class: 'row', style: 'margin-top:6px' }, 'Then go to', nextSel(n.next, v => { n.next = v; })) : null,
      n.type === 'choice' ? h('div', { style: 'margin-top:6px' }, ...(n.options || []).map((o, oi) => h('div', { class: 'row', style: 'margin-bottom:4px' }, h('input', { value: o.label, placeholder: 'Button label', oninput: e => { o.label = e.target.value; } }),
        '→', nextSel(o.next, v => { o.next = v; }), h('button', { class: 'btn sec sm', onclick: () => { n.options.splice(oi, 1); draw(); } }, '−'))),
        (n.options || []).length < 6 ? h('button', { class: 'btn sec sm', onclick: () => { n.options.push({ label: '', next: '' }); draw(); } }, '+ option') : null) : null)));
  };
  draw();
  const nm = h('input', { value: st.name, placeholder: 'e.g. Lead capture' }), kw = h('input', { value: st.keywords, placeholder: 'quote, demo, pricing help' }), en = h('input', { type: 'checkbox', checked: st.enabled });
  const m = h('div', { class: 'modal' },
    h('div', { class: 'card', style: 'width:640px;max-width:96vw;margin:0' }, h('h3', {}, f ? 'Edit flow' : 'New flow'), h('label', {}, 'Name'), nm, h('label', {}, 'Trigger keywords (comma separated)'), kw,
      h('label', { class: 'inline' }, en, 'Enabled'), h('label', {}, 'Steps (the flow begins at step #1)'), body,
      h('button', { class: 'btn sec sm', style: 'margin-top:10px', onclick: () => { let k = st.nodes.length + 1; while (st.nodes.some(n => n.id === 'n' + k)) k++; st.nodes.push({ id: 'n' + k, type: 'message', text: '', next: '' }); draw(); } }, '+ Add step'), err,
      h('div', { class: 'row', style: 'margin-top:16px;justify-content:flex-end' }, h('button', { class: 'btn sec', onclick: () => m.remove() }, 'Cancel'),
        h('button', { class: 'btn', onclick: async () => {
          const payload = { name: nm.value, keywords: kw.value, enabled: en.checked, nodes: st.nodes };
          try { await (f ? api('/flows/' + f.id, 'PUT', payload) : api('/flows', 'POST', payload)); m.remove(); renderShell(); } catch (e) { err.textContent = e.message; }
        } }, 'Save flow'))));
  document.body.append(m);
}
function ruleEditor(main, r) {
  const f = { name: h('input', { value: r?.name || '' }), keywords: h('input', { value: r?.keywords || '', placeholder: 'price, pricing, cost' }), reply: h('textarea', { rows: 3 }, r?.reply || ''),
    buttons: h('input', { value: (r?.buttons || []).join(', '), placeholder: 'Pricing, Talk to a human' }), handoff: h('input', { type: 'checkbox', checked: !!r?.handoff }), enabled: h('input', { type: 'checkbox', checked: r ? r.enabled : true }) };
  const m = h('div', { class: 'modal' },
    h('div', { class: 'card', style: 'width:480px;max-width:94vw;margin:0' }, h('h3', {}, r ? 'Edit rule' : 'New rule'),
      h('label', {}, 'Name'), f.name, h('label', {}, 'Trigger keywords (comma separated)'), f.keywords, h('label', {}, 'Bot reply'), f.reply,
      h('label', {}, 'Quick-reply buttons (comma separated, optional)'), f.buttons,
      h('label', { class: 'inline' }, f.handoff, 'Hand over to a human after replying'), h('label', { class: 'inline' }, f.enabled, 'Enabled'),
      h('div', { class: 'row', style: 'margin-top:16px;justify-content:flex-end' }, h('button', { class: 'btn sec', onclick: () => m.remove() }, 'Cancel'),
        h('button', { class: 'btn', onclick: guard(async () => {
          const body = { name: f.name.value, keywords: f.keywords.value, reply: f.reply.value, buttons: f.buttons.value.split(',').map(s => s.trim()).filter(Boolean), handoff: f.handoff.checked, enabled: f.enabled.checked };
          await (r ? api('/rules/' + r.id, 'PUT', body) : api('/rules', 'POST', body)); m.remove(); renderShell();
        }) }, 'Save'))));
  document.body.append(m);
}

// ---------- settings ----------
let settingsTab = 'widget';
async function renderSettings(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const TABS = [['widget', 'Widget', 'settings.manage'], ['sites', 'Websites'], ['canned', 'Saved replies'], ['team', 'Team', 'team.manage'], ['roles', 'Roles & permissions', 'roles.manage'],
    ['audit', 'Audit log', 'audit.view'], ['workspace', 'Workspace'], ['account', 'My account']].filter(t => !t[2] || can(t[2]) || (t[0] === 'widget' && false));
  if (!TABS.some(t => t[0] === settingsTab)) settingsTab = TABS[0][0];
  page.append(h('h2', {}, 'Settings'), h('div', { class: 'tabs' }, ...TABS.map(([k, l]) => h('button', { class: settingsTab === k ? 'on' : '', onclick: () => { settingsTab = k; renderShell(); } }, l))));
  const admin = can('settings.manage');
  if (settingsTab === 'widget') {
    page.append(siteBar());

    const { settings: s } = await api('/settings');
    const KEYS = ['title', 'subtitle', 'brandName', 'color', 'position', 'gradient', 'launcherStyle', 'launcherLabel', 'avatarUrl', 'theme', 'showBranding', 'prechatForm', 'greeting', 'fallbackMessage', 'handoffMessage', 'offlineMessage',
      'askEmail', 'ratingEnabled', 'proactiveEnabled', 'proactiveDelay', 'proactiveMessage', 'allowedOrigins', 'businessHoursEnabled', 'hoursStart', 'hoursEnd', 'hoursDays', 'timezone', 'webhookUrl', 'emailNotifications', 'emailReplies', 'emailTranscript'];
    const g = k => { const e = document.getElementById('s_' + k); return !e ? s[k] : e.type === 'checkbox' ? e.checked : e.value; };
    const upd = () => drawPreview();
    const inp = (k, label, type = 'text', hint) => [h('label', {}, label), h('input', { id: 's_' + k, type, value: s[k], disabled: !admin, oninput: upd }), hint ? h('div', { class: 'hint' }, hint) : null];
    const txt = (k, label) => [h('label', {}, label), h('textarea', { id: 's_' + k, rows: 2, disabled: !admin, oninput: upd }, s[k])];
    const chk = (k, label) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', id: 's_' + k, checked: s[k], disabled: !admin, onchange: upd }), label);
    const sel = (k, label, opts) => [h('label', {}, label), h('select', { id: 's_' + k, disabled: !admin, onchange: upd }, ...opts.map(([v, l]) => h('option', { value: v, selected: s[k] === v }, l)))];
    const preview = h('div', { class: 'preview' });
    function drawPreview() {
      const c = /^#[0-9a-f]{6}$/i.test(g('color')) ? g('color') : '#6366f1', dark = g('theme') === 'dark', right = g('position') !== 'left', pill = g('launcherStyle') === 'pill';
      const av = g('avatarUrl');
      const head = g('gradient') ? `linear-gradient(135deg,${c},color-mix(in srgb,${c} 65%,#000))` : c;
      preview.replaceChildren(
        h('div', { class: 'pv-panel' + (dark ? ' dark' : '') }, h('div', { class: 'pv-head', style: `background:${head}` }, h('div', { class: 'a' }, av ? h('img', { src: av, alt: '' }) : '💬'),
          h('div', {}, h('b', {}, g('title') || ' '), h('div', { style: 'font-size:12px;opacity:.9' }, '🟢 ' + (g('subtitle') || '')))),
          h('div', { class: 'pv-body' }, h('div', { class: 'pv-b' }, g('greeting')), h('div', { class: 'pv-v', style: `background:${c}` }, 'What are your prices?'), h('div', { class: 'pv-b' }, 'Our plans start at $19/month.'),
            h('div', { class: 'row', style: 'gap:6px;margin-top:4px' }, ...['Pricing', 'Talk to a human'].map(x => h('span', { style: `border:1.5px solid ${c};color:${c};border-radius:16px;padding:4px 11px;font-size:12px` }, x)))),
          g('showBranding') ? h('div', { style: 'text-align:center;font-size:11px;color:#9ca3af;padding:6px;background:inherit' }, '⚡ Powered by ' + (g('brandName') || 'Chatly')) : null),
        h('div', { style: `align-self:${right ? 'flex-end' : 'flex-start'}`, class: 'pv-launch' }, (() => { const i = icon('msg', 22); i.style.stroke = '#fff'; return i; })(), pill ? g('launcherLabel') : null));
      preview.lastChild.style.background = c;
    }
    const save = guard(async () => {
      await api('/settings', 'PUT', Object.fromEntries(KEYS.map(k => [k, g(k)]))); toast('Saved — reload your site to see the changes');
    });
    page.append(h('div', { class: 'split' }, h('div', {},
      h('div', { class: 'card' }, h('h3', {}, 'Appearance'), h('div', { class: 'grid2' }, h('div', {}, ...inp('title', 'Title'), ...inp('color', 'Brand colour', 'color')), h('div', {}, ...inp('subtitle', 'Subtitle'), ...sel('position', 'Position', [['right', 'Bottom right'], ['left', 'Bottom left']]))),
        h('div', { class: 'grid2' }, h('div', {}, ...sel('launcherStyle', 'Launcher', [['circle', 'Round icon'], ['pill', 'Pill with label']])), h('div', {}, ...inp('launcherLabel', 'Launcher label'))),
        h('div', { class: 'grid2' }, h('div', {}, ...sel('theme', 'Theme', [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Match visitor system']])), h('div', {}, ...inp('avatarUrl', 'Avatar image URL', 'text', 'Shown in the header and next to replies'))),
        chk('gradient', 'Gradient header'), chk('showBranding', 'Show "Powered by" footer'), ...inp('brandName', 'Brand name (footer)')),
      h('div', { class: 'card' }, h('h3', {}, 'Messages'), ...txt('greeting', 'Welcome message'), ...txt('fallbackMessage', 'Bot fallback message'), ...txt('handoffMessage', 'Handoff message (agents online)'), ...txt('offlineMessage', 'Offline message (no agents online)')),
      h('div', { class: 'card' }, h('h3', {}, 'Behaviour'), chk('prechatForm', 'Ask for name and email before the first message (pre-chat form)'), chk('askEmail', 'Ask for email when handing over to a human'), chk('ratingEnabled', 'Ask for a satisfaction rating when a chat is closed'),
        chk('proactiveEnabled', 'Show proactive greeting bubble'), ...inp('proactiveDelay', 'Proactive delay (seconds)', 'number'), ...inp('proactiveMessage', 'Proactive message')),
      h('div', { class: 'card' }, h('h3', {}, 'Email'), h('div', { class: 'hint' }, S.mailConfigured ? '✓ SMTP is configured on the server.' : 'Set SMTP_URL (e.g. smtp://user:pass@smtp.example.com:587) and SMTP_FROM on the server to enable email.'),
        chk('emailNotifications', 'Email the team when a visitor needs a human and nobody is online'), chk('emailReplies', 'Email the visitor an agent reply when they have left the site'), chk('emailTranscript', 'Email the visitor a transcript when a chat is closed'),
        admin && S.mailConfigured ? h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('/mail/test', 'POST', {}); toast('Test email sent to ' + S.me.email); }) }, 'Send test email') : null),
      h('div', { class: 'card' }, h('h3', {}, 'Business hours & integrations'), chk('businessHoursEnabled', 'Only show as online during business hours'),
        h('div', { class: 'grid2' }, h('div', {}, ...inp('hoursStart', 'Opens (HH:MM)'), ...inp('hoursDays', 'Open days', 'text', '0 = Sunday … 6 = Saturday')), h('div', {}, ...inp('hoursEnd', 'Closes (HH:MM)'), ...inp('timezone', 'Timezone', 'text', 'e.g. America/New_York'))),
        ...inp('webhookUrl', 'Webhook URL', 'text', 'Receives JSON POSTs: conversation.created, message.created, visitor.identified, conversation.closed, conversation.rated'),
        ...inp('allowedOrigins', 'Allowed origins', 'text', 'Use * for any site, or a comma-separated list like https://shop.com')),
      admin ? h('button', { class: 'btn', style: 'padding:11px 22px', onclick: save }, 'Save changes') : h('div', { class: 'hint' }, 'Only admins can change settings.')), preview));
    drawPreview();
  } else if (settingsTab === 'sites') {
    const manage = can('sites.manage');
    const nm = h('input', { placeholder: 'Website name, e.g. Acme Store' }), dm = h('input', { placeholder: 'https://acme.com (optional)' });
    page.append(...S.sites.map(site => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', {}, site.name), h('div', { class: 'hint', style: 'margin:0' }, site.domain || 'No domain set')),
        manage ? [h('button', { class: 'btn sec sm', onclick: guard(async () => { const n = prompt('Website name', site.name); if (!n) return; const d = prompt('Domain (optional)', site.domain || '') ?? site.domain; await api('/sites/' + site.id, 'PUT', { name: n, domain: d }); await boot(); }) }, 'Rename'),
          h('button', { class: 'btn sec sm', title: 'Issue a new install key. The old snippet stops working immediately.', onclick: guard(async () => { if (!confirm('Rotate the install key? The current snippet will stop working until you replace it.')) return; await api(`/sites/${site.id}/rotate-key`, 'POST'); toast('New key issued'); await boot(); }) }, 'Rotate key'),
          S.sites.length > 1 ? h('button', { class: 'btn danger sm', onclick: guard(async () => { if (prompt(`This permanently deletes "${site.name}" with all its conversations and contacts. Type the website name to confirm.`) !== site.name) return; await api('/sites/' + site.id, 'DELETE'); S.site = 0; await boot(); }) }, 'Delete') : null] : null),
      h('p', { class: 'hint' }, 'Paste this before </body> on every page of this website:'), h('pre', { class: 'code' }, snippet(site)),
      h('div', { class: 'row' }, h('button', { class: 'btn sec sm', onclick: () => { navigator.clipboard?.writeText(snippet(site)); toast('Copied'); } }, 'Copy snippet'),
        h('span', { class: 'hint', style: 'margin:0' }, 'Works on any site: WordPress, Shopify, Wix, Webflow, custom HTML. JS API: Chatly.open() / Chatly.close()')))),
      manage ? h('div', { class: 'card' }, h('h3', {}, 'Add a website'), h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Name'), nm), h('div', {}, h('label', {}, 'Domain'), dm)),
        h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { const r = await api('/sites', 'POST', { name: nm.value, domain: dm.value }); S.site = r.site.id; toast('Website added with its own chatbot, settings and install code'); await boot(); }) }, icon('plus', 16), 'Add website')) : null);
  } else if (settingsTab === 'canned') {
    const sc = h('input', { placeholder: 'shortcut, e.g. thanks' }), tx = h('textarea', { rows: 2, placeholder: 'Reply text' }), manage = can('canned.manage');
    page.append(manage ? h('div', { class: 'card' }, h('h3', {}, 'Saved replies'), h('div', { class: 'hint' }, 'Shared by the whole workspace. In the inbox, type / and a shortcut to insert one.'), h('label', {}, 'Shortcut'), sc, h('label', {}, 'Text'), tx,
      h('button', { class: 'btn', style: 'margin-top:10px', onclick: guard(async () => { await api('/canned', 'POST', { shortcut: sc.value, text: tx.value }); S.canned = (await api('/canned')).canned; renderShell(); }) }, 'Add')) : null,
      h('div', { class: 'card' }, h('table', {}, h('tbody', {}, ...S.canned.map(c => h('tr', {}, h('td', {}, h('b', {}, '/' + c.shortcut)), h('td', {}, c.text),
        h('td', {}, manage ? h('button', { class: 'btn danger sm', onclick: guard(async () => { await api('/canned/' + c.id, 'DELETE'); S.canned = (await api('/canned')).canned; renderShell(); }) }, 'Delete') : null)))))));
  } else if (settingsTab === 'team') {
    const [{ members }, { roles }] = await Promise.all([api('/members'), api('/roles')]); S.members = members;
    const grantable = roles.filter(r => r.permissions.every(p => S.perms.has(p)));
    const roleSel = (val) => h('select', {}, ...grantable.map(r => h('option', { value: r.id, selected: r.id === val }, r.name)));
    const sitePick = (ids) => { const box = h('div', { class: 'sitepick' }), all = h('input', { type: 'checkbox', checked: !ids });
      const boxes = S.sites.map(x => h('input', { type: 'checkbox', value: x.id, checked: !ids || ids.includes(x.id), disabled: !ids }));
      all.onchange = () => boxes.forEach(b => { b.disabled = all.checked; b.checked = all.checked; });
      box.append(h('label', { class: 'inline' }, all, 'All websites (including future ones)'), ...S.sites.map((x, i) => h('label', { class: 'inline', style: 'margin-left:22px' }, boxes[i], x.name)));
      box.value = () => all.checked ? null : boxes.filter(b => b.checked).map(b => +b.value); return box; };
    const editMember = m => {
      const rs = roleSel(m.role_id), sp = sitePick(m.site_ids);
      const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:460px;max-width:96vw' }, h('h3', {}, 'Edit access — ' + m.name), h('label', {}, 'Role'), rs, S.sites.length > 1 ? [h('label', {}, 'Websites'), sp] : null,
        h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
          h('button', { class: 'btn', onclick: guard(async () => { await api('/members/' + m.id, 'PUT', { role_id: +rs.value, site_ids: sp.value() }); md.remove(); toast('Access updated — applies immediately'); renderShell(); }) }, 'Save'))));
      document.body.append(md);
    };
    const canTouch = m => m.id !== S.me.id && (roles.find(r => r.id === m.role_id)?.permissions || []).every(p => S.perms.has(p));
    const f = { name: h('input', { placeholder: 'Full name' }), email: h('input', { type: 'email', placeholder: 'name@company.com' }), password: h('input', { type: 'password', placeholder: 'Temporary password (min 8)' }) };
    const rs = roleSel(roles.find(r => r.name === 'Agent')?.id), sp = sitePick(null);
    page.append(h('div', { class: 'card', style: 'padding:0' }, h('table', {}, h('thead', {}, h('tr', {}, ...['Teammate', 'Role', 'Websites', 'Status', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, ...members.map(m => h('tr', {}, h('td', {}, h('div', { class: 'row' }, avEl({ id: m.email, name: m.name }), h('div', {}, h('b', {}, m.name, m.id === S.me.id ? ' (you)' : ''), h('div', { class: 'hint', style: 'margin:0' }, m.email)))),
        h('td', {}, h('span', { class: 'pill' + (m.role === 'Owner' ? ' warn' : '') }, m.role)), h('td', {}, m.site_ids ? m.site_ids.map(id => S.sites.find(x => x.id === id)?.name).filter(Boolean).join(', ') : 'All'),
        h('td', {}, h('span', { class: 'pill ' + (m.online ? 'ok' : '') }, m.online ? 'online' : 'offline')),
        h('td', { style: 'text-align:right' }, canTouch(m) ? [h('button', { class: 'btn sec sm', onclick: () => editMember(m) }, 'Edit'), ' ',
          h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm(`Remove ${m.name} from ${S.workspace.name}?`)) { await api('/members/' + m.id, 'DELETE'); renderShell(); } }) }, 'Remove')] : null)))))),
      h('div', { class: 'card' }, h('h3', {}, 'Invite a teammate'), h('div', { class: 'hint' }, 'If they already have a Chatly account (in another workspace) just enter their email — no password needed.'),
        h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Name'), f.name, h('label', {}, 'Email'), f.email), h('div', {}, h('label', {}, 'Role'), rs, h('label', {}, 'Temporary password'), f.password)),
        S.sites.length > 1 ? [h('label', {}, 'Website access'), sp] : null,
        h('button', { class: 'btn', style: 'margin-top:14px', onclick: guard(async () => {
          const r = await api('/members', 'POST', { name: f.name.value, email: f.email.value, password: f.password.value, role_id: +rs.value, site_ids: sp.value() });
          toast(r.created ? 'Account created — share the email and temporary password with them' : 'Existing user added to this workspace'); renderShell();
        }) }, icon('plus', 16), 'Add teammate')));
  } else if (settingsTab === 'roles') {
    const { roles } = await api('/roles');
    const groups = {}; for (const [k, d] of Object.entries(S.catalog)) (groups[k.split('.')[0]] ||= []).push([k, d]);
    const LABEL = { chats: 'Conversations', contacts: 'Contacts', canned: 'Saved replies', bot: 'Automation', settings: 'Settings', sites: 'Websites', team: 'Team', roles: 'Roles', analytics: 'Reports', audit: 'Security', workspace: 'Workspace' };
    const editor = r => {
      const nm = h('input', { value: r?.name || '', placeholder: 'e.g. Sales agent' }), boxes = {};
      const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:620px;max-width:96vw' }, h('h3', {}, r ? 'Edit role' : 'New role'), h('label', {}, 'Role name'), nm,
        h('label', {}, 'Permissions'), h('div', { class: 'permgrid' }, ...Object.entries(groups).map(([g, list]) => h('div', { class: 'permgroup' }, h('b', {}, LABEL[g] || g),
          ...list.map(([k, d]) => { const own = S.perms.has(k); boxes[k] = h('input', { type: 'checkbox', checked: r ? r.permissions.includes(k) : false, disabled: !own });
            return h('label', { class: 'inline', title: own ? k : "You don't have this permission, so you can't grant it" }, boxes[k], h('span', {}, d)); })))),
        h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
          h('button', { class: 'btn', onclick: guard(async () => { const body = { name: nm.value, permissions: Object.keys(boxes).filter(k => boxes[k].checked) };
            await (r ? api('/roles/' + r.id, 'PUT', body) : api('/roles', 'POST', body)); md.remove(); toast('Role saved — applies immediately'); renderShell(); }) }, 'Save role'))));
      document.body.append(md);
    };
    page.append(h('div', { class: 'row', style: 'margin-bottom:14px' }, h('p', { class: 'hint grow', style: 'margin:0' }, 'Roles decide what each teammate can see and do. Changes apply instantly to everyone with that role. You can only grant permissions you have yourself.'),
      h('button', { class: 'btn', onclick: () => editor(null) }, icon('plus', 16), 'New role')),
      ...roles.map(r => h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', {}, r.name, ' ', r.system ? h('span', { class: 'pill warn' }, 'all permissions') : null),
        h('div', { class: 'hint', style: 'margin:0' }, `${r.members} member${r.members === 1 ? '' : 's'} · ${r.permissions.length} of ${Object.keys(S.catalog).length} permissions`)),
        !r.system && r.permissions.every(p => S.perms.has(p)) ? [h('button', { class: 'btn sec sm', onclick: () => editor(r) }, 'Edit'),
          h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm(`Delete role "${r.name}"?`)) { await api('/roles/' + r.id, 'DELETE'); renderShell(); } }) }, 'Delete')] : null),
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:5px;margin-top:10px' }, ...r.permissions.map(p => h('span', { class: 'tag', title: S.catalog[p] }, p))))));
  } else if (settingsTab === 'audit') {
    const { entries } = await api('/audit');
    page.append(h('div', { class: 'card', style: 'padding:0' }, entries.length ? h('table', {}, h('thead', {}, h('tr', {}, ...['When', 'Who', 'Action', 'Details'].map(x => h('th', {}, x)))),
      h('tbody', {}, ...entries.map(e => h('tr', {}, h('td', { style: 'white-space:nowrap' }, new Date(e.created).toLocaleString()), h('td', {}, e.user_name), h('td', {}, h('span', { class: 'tag' }, e.action)), h('td', {}, e.detail || '')))))
      : h('div', { class: 'empty' }, 'No activity yet')));
  } else if (settingsTab === 'workspace') {
    const nm = h('input', { value: S.workspace.name, disabled: !can('workspace.manage') }), nw = h('input', { placeholder: 'e.g. My agency' });
    page.append(h('div', { class: 'card', style: 'max-width:560px' }, h('h3', {}, 'This workspace'), h('label', {}, 'Name'), nm,
      can('workspace.manage') ? h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { await api('/workspace', 'PUT', { name: nm.value }); toast('Renamed'); await boot(); }) }, 'Save') : h('div', { class: 'hint' }, 'Only the workspace Owner can rename it.'),
      h('p', { class: 'hint', style: 'margin-top:14px' }, `You are ${S.role.name} here. ${S.sites.length} website${S.sites.length === 1 ? '' : 's'}, ${S.members.length} teammate${S.members.length === 1 ? '' : 's'}.`)),
      h('div', { class: 'card', style: 'max-width:560px' }, h('h3', {}, 'Create another workspace'), h('div', { class: 'hint' }, 'Separate business or client? Each workspace has its own websites, team, roles and data. Switch between them from the top of the sidebar.'),
        h('label', {}, 'Workspace name'), nw, h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { await api('/workspaces', 'POST', { name: nw.value }); S.site = 0; await boot(); toast('Workspace created'); }) }, 'Create workspace')));
  } else {
    const nm = h('input', { value: S.me.name }), cur = h('input', { type: 'password' }), nw = h('input', { type: 'password', placeholder: 'At least 8 characters' });
    page.append(h('div', { class: 'card', style: 'max-width:460px' }, h('h3', {}, 'Profile'), h('label', {}, 'Name'), nm, h('label', {}, 'Email'), h('input', { value: S.me.email, disabled: true }),
      h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { await api('/me', 'PUT', { name: nm.value }); toast('Saved'); await boot(); }) }, 'Save')),
      h('div', { class: 'card', style: 'max-width:460px' }, h('h3', {}, 'Change password'), h('div', { class: 'hint' }, 'Signs you out on all other devices.'), h('label', {}, 'Current password'), cur, h('label', {}, 'New password'), nw,
        h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { await api('/me/password', 'POST', { current: cur.value, password: nw.value }); cur.value = nw.value = ''; toast('Password updated'); }) }, 'Update password')));
  }
}

window.addEventListener('focus', () => { if (S.view === 'inbox' && S.cur) api(`/conversations/${S.cur}/read`, 'POST').catch(() => {}); });
boot();
})();
