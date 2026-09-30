(() => {
const $app = document.getElementById('app');
const S = { aiConfigured: false, me: null, siteKey: '', convs: new Map(), cur: null, msgs: [], filter: 'open', q: '', visitors: new Map(), agents: [], canned: [], view: 'inbox', typing: {}, mode: 'reply', stats: null };
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
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/auth/login') { S.me = null; return renderLogin(); }
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
function toast(msg) { const t = h('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2500); }
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const vname = v => v?.name || v?.email || 'Visitor ' + (v?.id || '').slice(1, 6);
const initials = v => vname(v).replace(/^Visitor /, '').slice(0, 2).toUpperCase();
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
function beep() { try { const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(), g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.setValueAtTime(.08, c.currentTime); g.gain.exponentialRampToValueAtTime(.001, c.currentTime + .25); o.start(); o.stop(c.currentTime + .25); } catch {} }

// ---------- login ----------
function renderLogin() {
  if (es) es.close();
  const err = h('div', { class: 'err' });
  const email = h('input', { type: 'email', placeholder: 'you@company.com', autocomplete: 'username', required: true });
  const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  $app.replaceChildren(h('form', { class: 'login', onsubmit: async e => {
    e.preventDefault();
    try { await api('/auth/login', 'POST', { email: email.value, password: pw.value }); boot(); } catch (x) { err.textContent = x.message; }
  } }, h('h1', {}, '💬 Chatly'), h('div', { class: 'hint' }, 'Sign in to your dashboard'),
    h('label', {}, 'Email'), email, h('label', {}, 'Password'), pw, err,
    h('button', { class: 'btn', style: 'width:100%;margin-top:16px' }, 'Sign in')));
}

// ---------- shell ----------
async function boot() {
  try { const d = await api('/me'); S.me = d.agent; S.siteKey = d.siteKey; S.aiConfigured = d.aiConfigured; } catch { return renderLogin(); }
  if (!S.me) return;
  const [a, c] = await Promise.all([api('/agents'), api('/canned')]);
  S.agents = a.agents; S.canned = c.canned;
  connect(); renderShell();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}
function totalUnread() { let n = 0; for (const c of S.convs.values()) if (c.status === 'open') n += c.unread ? 1 : 0; return n; }
function renderShell() {
  const link = (v, icon, label) => h('a', { class: S.view === v ? 'on' : '', onclick: () => { S.view = v; renderShell(); } }, icon, h('span', { class: 'lbl' }, label),
    v === 'inbox' && totalUnread() ? h('span', { class: 'cnt' }, totalUnread()) : null);
  const views = { inbox: renderInbox, visitors: renderVisitors, bot: renderBot, settings: renderSettings, dashboard: renderDashboard };
  const main = h('div', { class: 'main', id: 'main' });
  $app.replaceChildren(h('div', { class: 'shell' },
    h('div', { class: 'nav' }, h('div', { class: 'brand' }, '💬 Chatly'),
      link('dashboard', '📊', 'Overview'), link('inbox', '📥', 'Inbox'), link('visitors', '👀', 'Visitors'), link('bot', '🤖', 'Chatbot'), link('settings', '⚙️', 'Settings'),
      h('div', { class: 'me' }, h('b', {}, S.me.name), S.me.role, h('br'), h('button', { onclick: async () => { await api('/auth/logout', 'POST'); S.me = null; renderLogin(); } }, 'Sign out'))),
    main));
  views[S.view](main);
}
const refreshNavBadge = () => { const a = document.querySelector('.nav a:nth-child(3)'); if (!a) return; a.querySelector('.cnt')?.remove(); if (totalUnread()) a.append(h('span', { class: 'cnt' }, totalUnread())); };

// ---------- realtime ----------
function connect() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.addEventListener('ready', () => { if (S.view === 'inbox') loadConvs(); });
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
    if (S.view === 'inbox') { drawList(); if (S.cur === c.id) { drawHead(); drawSide(); } }
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
  const d = await api('/conversations?' + p);
  S.convs = new Map(d.conversations.map(c => [c.id, c]));
  drawList(); refreshNavBadge();
}
function visibleConvs() {
  return [...S.convs.values()].filter(c => {
    if (S.filter === 'closed') return c.status === 'closed';
    if (c.status !== 'open') return false;
    if (S.filter === 'mine') return c.assignee_id === S.me.id;
    if (S.filter === 'unassigned') return !c.assignee_id;
    if (S.filter === 'human') return c.needs_human;
    return true;
  }).sort((a, b) => (b.needs_human - a.needs_human) || b.updated - a.updated);
}
function renderInbox(main) {
  main.append(h('div', { class: 'inbox' },
    h('div', { class: 'list' },
      h('div', { class: 'top' },
        h('input', { placeholder: 'Search conversations…', value: S.q, oninput: debounce(e => { S.q = e.target.value; loadConvs(); }, 250) }),
        h('div', { class: 'filters' }, ...[['open', 'All open'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['human', 'Needs human'], ['closed', 'Closed']]
          .map(([k, l]) => h('button', { class: S.filter === k ? 'on' : '', onclick: () => { S.filter = k; renderShell(); } }, l)))),
      h('div', { class: 'items', id: 'items' })),
    h('div', { class: 'chat', id: 'chat' }), h('div', { class: 'side', id: 'side' })));
  loadConvs().then(() => { if (S.cur && S.convs.has(S.cur)) openConv(S.cur); else drawChatEmpty(); });
  drawSide();
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function drawList() {
  const box = document.getElementById('items'); if (!box) return;
  const list = visibleConvs();
  box.replaceChildren(...(list.length ? list.map(c => h('div', { class: 'item' + (c.id === S.cur ? ' on' : ''), onclick: () => openConv(c.id) },
    h('div', { class: 'av' }, initials(c.visitor), c.visitor.online ? h('span', { class: 'on-dot' }) : null),
    h('div', { style: 'min-width:0;flex:1' },
      h('div', { class: 'nm' }, vname(c.visitor), c.needs_human ? h('span', { class: 'pill bad' }, 'human') : null, c.unread ? h('span', { class: 'unread' }, c.unread) : null, h('span', { class: 't' }, ago(c.updated))),
      h('div', { class: 'lb' }, c.last_body || '…'),
      c.assignee_name ? h('div', { class: 'hint' }, '→ ' + c.assignee_name) : null))) : [h('div', { class: 'empty', style: 'padding:40px 10px' }, 'No conversations here')]));
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
  chat.replaceChildren(h('div', { class: 'hd', id: 'hd' }), h('div', { class: 'msgs', id: 'msgs' }), h('div', { class: 'typing', id: 'typing' }),
    h('div', { class: 'composer' }, menu, h('div', { class: 'modes' }, modeBtn('reply', 'Reply', ''), modeBtn('note', 'Internal note', 'note')), ta,
      h('div', { class: 'row', style: 'margin-top:6px;justify-content:space-between' }, h('span', { class: 'hint' }, fileIn, h('button', { class: 'btn sec sm', onclick: () => fileIn.click() }, '📎 Attach'), ' Enter to send · Shift+Enter for newline'), h('button', { class: 'btn', onclick: send }, 'Send'))));
  drawHead(); drawMessages(); drawSide(); drawList(); ta.focus();
}
function drawHead() {
  const hd = document.getElementById('hd'), c = S.convs.get(S.cur); if (!hd || !c) return;
  const assign = h('select', { onchange: guard(async e => { await api(`/conversations/${c.id}/assign`, 'POST', { agent_id: e.target.value ? +e.target.value : null }); }) },
    h('option', { value: '' }, 'Unassigned'), ...S.agents.map(a => h('option', { value: a.id, selected: a.id === c.assignee_id }, a.name)));
  hd.replaceChildren(h('div', { class: 'av' }, initials(c.visitor)), h('div', { class: 'grow', style: 'flex:1' }, h('b', {}, vname(c.visitor)),
    h('div', { class: 'hint' }, c.visitor.online ? '🟢 online' : 'offline', c.bot_active ? ' · 🤖 bot handling' : '')), assign,
    h('button', { class: 'btn sec', onclick: guard(() => api(`/conversations/${c.id}/status`, 'POST', { status: c.status === 'open' ? 'closed' : 'open' })) }, c.status === 'open' ? '✓ Close' : 'Reopen'),
    h('a', { class: 'btn sec', href: `/api/conversations/${c.id}/transcript`, title: 'Download transcript', style: 'text-decoration:none' }, '⬇'),
    S.me.role === 'admin' ? h('button', { class: 'btn danger', title: 'Delete', onclick: guard(async () => { if (confirm('Delete this conversation permanently?')) await api('/conversations/' + c.id, 'DELETE'); }) }, '🗑') : null);
}
function drawMessages() {
  const box = document.getElementById('msgs'); if (!box) return;
  const out = []; let prev = null;
  for (const m of S.msgs) {
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
async function renderVisitors(main) {
  main.append(h('div', { class: 'page' }, h('div', { class: 'row', style: 'margin-bottom:16px' }, h('h2', { class: 'grow', style: 'margin:0' }, 'Live visitors'), h('a', { class: 'btn sec', href: '/api/export/contacts.csv', style: 'text-decoration:none' }, 'Export contacts (CSV)')), h('div', { class: 'card', id: 'vis' })));
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
  const [s, an] = await Promise.all([api('/stats'), api('/analytics')]);
  const max = Math.max(1, ...an.days.map(d => d.chats));
  const st = (n, l) => h('div', { class: 'stat' }, h('b', {}, n), h('span', {}, l));
  page.append(h('h2', {}, 'Welcome back, ' + S.me.name), h('div', { class: 'grid' }, st(s.open, 'Open conversations'), st(s.needsHuman, 'Waiting for a human'), st(s.unassigned, 'Unassigned'),
    st(s.visitorsOnline, 'Visitors online'), st(s.today, 'New chats today'), st(s.messagesToday, 'Messages today'), st(s.resolved, 'Resolved total'), st(s.agentsOnline, 'Agents online')),
    h('div', { class: 'card' }, h('h3', {}, 'Conversations — last 14 days'),
      h('div', { style: 'display:flex;align-items:flex-end;gap:6px;height:110px;margin:14px 0 4px' }, ...an.days.map(d => h('div', { title: `${d.date}: ${d.chats} chats, ${d.messages} messages`, style: `flex:1;background:#818cf8;border-radius:4px 4px 0 0;height:${Math.max(3, d.chats / max * 100)}%` }))),
      h('div', { class: 'row hint', style: 'justify-content:space-between' }, h('span', {}, an.days[0].date), h('span', {}, an.days[13].date)),
      h('div', { class: 'grid', style: 'margin:14px 0 0' }, st(an.avgFirstResponseSec == null ? '—' : an.avgFirstResponseSec < 90 ? an.avgFirstResponseSec + 's' : Math.round(an.avgFirstResponseSec / 60) + 'm', 'Avg first response'),
        st(an.csat == null ? '—' : an.csat + ' / 5', `Satisfaction (${an.ratings} ratings)`), st(an.botHandledPct + '%', 'Handled by bot only'), st(an.contacts, 'Contacts with email'))),
    h('div', { class: 'card' }, h('h3', {}, 'Get started'), h('p', {}, 'Add the chat widget to your website by pasting this snippet before </body>:'), h('pre', { class: 'code' }, snippet()),
      h('div', { class: 'row' }, h('button', { class: 'btn sec', onclick: () => { navigator.clipboard?.writeText(snippet()); toast('Copied'); } }, 'Copy snippet'), h('a', { href: '/', target: '_blank' }, 'Open demo site ↗'))));
}
const snippet = () => `<script src="${location.origin}/widget.js" data-key="${S.siteKey}" async></script>`;

// ---------- chatbot ----------
async function renderBot(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const [{ rules }, { settings }, { kb }] = await Promise.all([api('/rules'), api('/settings'), api('/kb')]);
  const admin = S.me.role === 'admin';
  page.append(h('h2', {}, 'Chatbot'),
    h('div', { class: 'card' }, h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: settings.botEnabled, disabled: !admin, onchange: guard(async e => { await api('/settings', 'PUT', { botEnabled: e.target.checked }); toast('Saved'); }) }), 'Enable chatbot for new conversations'),
      h('div', { class: 'hint' }, 'The bot answers with the first rule that matches, and hands over to a human on request. As soon as an agent replies, the bot stops.'),
      h('label', {}, 'Try it'), h('div', { class: 'row' }, h('input', { id: 'bt', placeholder: 'Type a visitor message to test the rules…', class: 'grow' }),
        h('button', { class: 'btn sec', onclick: guard(async () => { const { rule } = await api('/bot/test', 'POST', { text: document.getElementById('bt').value }); document.getElementById('btr').textContent = rule ? `✓ "${rule.name}" → ${rule.reply}` : '✗ No rule matches — fallback message is sent'; }) }, 'Test')), h('div', { class: 'hint', id: 'btr' })),
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
function ruleEditor(main, r) {
  const f = { name: h('input', { value: r?.name || '' }), keywords: h('input', { value: r?.keywords || '', placeholder: 'price, pricing, cost' }), reply: h('textarea', { rows: 3 }, r?.reply || ''),
    buttons: h('input', { value: (r?.buttons || []).join(', '), placeholder: 'Pricing, Talk to a human' }), handoff: h('input', { type: 'checkbox', checked: !!r?.handoff }), enabled: h('input', { type: 'checkbox', checked: r ? r.enabled : true }) };
  const m = h('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:5' },
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
  const tabs = h('div', { class: 'tabs' }, ...[['widget', 'Widget'], ['install', 'Install'], ['canned', 'Saved replies'], ['team', 'Team'], ['account', 'Account']].map(([k, l]) =>
    h('button', { class: settingsTab === k ? 'on' : '', onclick: () => { settingsTab = k; renderShell(); } }, l)));
  page.append(h('h2', {}, 'Settings'), tabs);
  const admin = S.me.role === 'admin';
  if (settingsTab === 'widget') {
    const { settings: s } = await api('/settings');
    const inp = (k, label, type = 'text', hint) => [h('label', {}, label), h('input', { id: 's_' + k, type, value: s[k], disabled: !admin }), hint ? h('div', { class: 'hint' }, hint) : null];
    const chk = (k, label) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', id: 's_' + k, checked: s[k], disabled: !admin }), label);
    page.append(h('div', { class: 'card' }, ...inp('title', 'Widget title'), ...inp('subtitle', 'Subtitle'), ...inp('brandName', 'Brand name (footer)'), ...inp('color', 'Brand color', 'color'),
      h('label', {}, 'Position'), h('select', { id: 's_position', disabled: !admin }, h('option', { value: 'right', selected: s.position === 'right' }, 'Bottom right'), h('option', { value: 'left', selected: s.position === 'left' }, 'Bottom left')),
      ...inp('greeting', 'Welcome message'), ...inp('fallbackMessage', 'Bot fallback message'), ...inp('handoffMessage', 'Handoff message (agents online)'), ...inp('offlineMessage', 'Offline message (no agents online)'),
      chk('askEmail', 'Ask for email when handing over to a human'), chk('ratingEnabled', 'Ask for a satisfaction rating when a chat is closed'), chk('proactiveEnabled', 'Show proactive greeting bubble'), ...inp('proactiveDelay', 'Proactive delay (seconds)', 'number'), ...inp('proactiveMessage', 'Proactive message'),
      chk('businessHoursEnabled', 'Only show as online during business hours'), ...inp('hoursStart', 'Opens (HH:MM)'), ...inp('hoursEnd', 'Closes (HH:MM)'),
      ...inp('hoursDays', 'Open days', 'text', 'Comma-separated, 0 = Sunday … 6 = Saturday, e.g. 1,2,3,4,5'), ...inp('timezone', 'Timezone', 'text', 'IANA name, e.g. America/New_York'),
      ...inp('webhookUrl', 'Webhook URL', 'text', 'Receives JSON POSTs for conversation.created, message.created, visitor.identified, conversation.closed, conversation.rated'),
      ...inp('allowedOrigins', 'Allowed origins', 'text', 'Use * for any site, or a comma-separated list like https://shop.com,https://www.shop.com'),
      admin ? h('button', { class: 'btn', style: 'margin-top:16px', onclick: guard(async () => {
        const g = k => { const e = document.getElementById('s_' + k); return e.type === 'checkbox' ? e.checked : e.value; };
        await api('/settings', 'PUT', Object.fromEntries(['title', 'subtitle', 'brandName', 'color', 'position', 'greeting', 'fallbackMessage', 'handoffMessage', 'offlineMessage', 'askEmail', 'proactiveEnabled', 'proactiveDelay', 'proactiveMessage', 'allowedOrigins', 'ratingEnabled', 'businessHoursEnabled', 'hoursStart', 'hoursEnd', 'hoursDays', 'timezone', 'webhookUrl'].map(k => [k, g(k)])));
        toast('Saved — reload the site to see changes');
      }) }, 'Save changes') : h('div', { class: 'hint' }, 'Only admins can change settings.')));
  } else if (settingsTab === 'install') {
    page.append(h('div', { class: 'card' }, h('h3', {}, 'Install on your website'), h('p', {}, 'Paste before the closing </body> tag on every page:'), h('pre', { class: 'code' }, snippet()),
      h('button', { class: 'btn sec', onclick: () => { navigator.clipboard?.writeText(snippet()); toast('Copied'); } }, 'Copy'),
      h('p', { class: 'hint' }, 'Control it from JavaScript with Chatly.open() and Chatly.close().')));
  } else if (settingsTab === 'canned') {
    const sc = h('input', { placeholder: 'shortcut, e.g. thanks' }), tx = h('textarea', { rows: 2, placeholder: 'Reply text' });
    page.append(h('div', { class: 'card' }, h('h3', {}, 'Saved replies'), h('div', { class: 'hint' }, 'In the inbox, type / and a shortcut to insert a reply.'), h('label', {}, 'Shortcut'), sc, h('label', {}, 'Text'), tx,
      h('button', { class: 'btn', style: 'margin-top:10px', onclick: guard(async () => { await api('/canned', 'POST', { shortcut: sc.value, text: tx.value }); S.canned = (await api('/canned')).canned; renderShell(); }) }, 'Add')),
      h('div', { class: 'card' }, h('table', {}, h('tbody', {}, ...S.canned.map(c => h('tr', {}, h('td', {}, h('b', {}, '/' + c.shortcut)), h('td', {}, c.text),
        h('td', {}, h('button', { class: 'btn danger sm', onclick: guard(async () => { await api('/canned/' + c.id, 'DELETE'); S.canned = (await api('/canned')).canned; renderShell(); }) }, 'Delete'))))))));
  } else if (settingsTab === 'team') {
    S.agents = (await api('/agents')).agents;
    const f = { name: h('input', { placeholder: 'Name' }), email: h('input', { type: 'email', placeholder: 'Email' }), password: h('input', { type: 'password', placeholder: 'Temporary password (min 6)' }), role: h('select', {}, h('option', { value: 'agent' }, 'Agent'), h('option', { value: 'admin' }, 'Admin')) };
    page.append(h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ...['Name', 'Email', 'Role', 'Status', ''].map(x => h('th', {}, x)))), h('tbody', {}, ...S.agents.map(a => h('tr', {}, h('td', {}, a.name), h('td', {}, a.email), h('td', {}, a.role),
      h('td', {}, h('span', { class: 'pill ' + (a.online ? 'ok' : '') }, a.online ? 'online' : 'offline')),
      h('td', {}, admin && a.id !== S.me.id ? h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm('Remove ' + a.name + '?')) { await api('/agents/' + a.id, 'DELETE'); renderShell(); } }) }, 'Remove') : null)))))),
      admin ? h('div', { class: 'card' }, h('h3', {}, 'Invite teammate'), h('div', { class: 'row', style: 'margin-top:8px' }, ...Object.values(f).map(x => h('div', { class: 'grow' }, x)),
        h('button', { class: 'btn', onclick: guard(async () => { await api('/agents', 'POST', { name: f.name.value, email: f.email.value, password: f.password.value, role: f.role.value }); toast('Teammate added'); renderShell(); }) }, 'Add'))) : null);
  } else {
    const cur = h('input', { type: 'password' }), nw = h('input', { type: 'password' });
    page.append(h('div', { class: 'card', style: 'max-width:420px' }, h('h3', {}, 'Change password'), h('label', {}, 'Current password'), cur, h('label', {}, 'New password'), nw,
      h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { await api('/me/password', 'POST', { current: cur.value, password: nw.value }); cur.value = nw.value = ''; toast('Password updated'); }) }, 'Update')));
  }
}

window.addEventListener('focus', () => { if (S.view === 'inbox' && S.cur) api(`/conversations/${S.cur}/read`, 'POST').catch(() => {}); });
boot();
})();
