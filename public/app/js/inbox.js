import { S, ago, api, avEl, can, guard, h, icon, mod, toast, vname } from './core.js';
import { refreshNavBadge, renderShell } from './shell.js';
import { newTicketDialog } from './tickets.js';

// ---------- inbox ----------
export async function loadConvs() {
  const p = new URLSearchParams();
  if (S.filter === 'closed') p.set('status', 'closed'); else { p.set('status', 'open'); if (S.filter !== 'open') p.set('filter', S.filter); }
  if (S.q) p.set('q', S.q);
  for (const [k, v] of Object.entries(S.f)) if (v) p.set(k, v);
  if (S.tag) p.set('tag', S.tag);
  const d = await api('/conversations?' + p);
  S.convs = new Map(d.conversations.map(c => [c.id, c]));
  drawList(); refreshNavBadge();
}
export function visibleConvs() {
  return [...S.convs.values()].filter(c => {
    if (S.tag && !(c.tags || []).includes(S.tag)) return false;
    if (S.f.priority && c.priority !== S.f.priority) return false;
    if (S.f.department && String(c.department_id ?? 'none') !== S.f.department) return false;
    if (S.f.assignee && String(c.assignee_id ?? 'none') !== S.f.assignee) return false;
    if (S.filter === 'closed') return c.status === 'closed';
    if (c.status !== 'open') return false;
    if (S.filter === 'snoozed') return !!c.snoozed_until;
    if (c.snoozed_until) return false;
    if (S.filter === 'mine') return c.assignee_id === S.me.id;
    if (S.filter === 'unassigned') return !c.assignee_id;
    if (S.filter === 'human') return c.needs_human;
    return true;
  }).sort((a, b) => (b.needs_human - a.needs_human) || (PRANK[b.priority] - PRANK[a.priority]) || b.updated - a.updated);
}
const PRANK = { urgent: 3, high: 2, normal: 1, low: 0 };
export const PRIORITY = { urgent: ['🔴', 'Urgent'], high: ['🟠', 'High'], normal: ['', 'Normal'], low: ['⚪', 'Low'] };
const sel = (value, onchange, ...opts) => h('select', { class: 'sm', onchange: e => onchange(e.target.value) }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
const setF = (k, v) => { S.f[k] = v; S.view_id = ''; renderShell(); };

function filterBar() {
  const deps = mod('departments') ? S.departments : [];
  return h('div', { class: 'filters fbar' },
    sel(S.f.priority, v => setF('priority', v), ['', 'Any priority'], ...Object.entries(PRIORITY).reverse().map(([k, [e, l]]) => [k, `${e} ${l}`.trim()])),
    deps.length ? sel(S.f.department, v => setF('department', v), ['', 'All departments'], ...deps.map(d => [d.id, d.name]), ['none', 'No department']) : null,
    can('chats.view_all') ? sel(S.f.assignee, v => setF('assignee', v), ['', 'Anyone'], ['none', 'Unassigned'], ...S.members.filter(m => m.can_reply).map(m => [m.id, m.name])) : null,
    viewsMenu());
}
/** Saved views: personal or shared filter presets. */
function viewsMenu() {
  const apply = id => {
    if (id === '__save') return saveView();
    const v = S.views.find(x => String(x.id) === id); S.view_id = id;
    if (!v) { S.f = { priority: '', department: '', assignee: '' }; S.filter = 'open'; S.q = ''; S.tag = ''; return renderShell(); }
    const f = v.filters; S.filter = f.status === 'closed' ? 'closed' : f.filter || 'open'; S.q = f.q || ''; S.tag = f.tag || '';
    S.f = { priority: f.priority || '', department: f.department || '', assignee: f.assignee || '' }; renderShell();
  };
  const cur = S.views.find(v => String(v.id) === S.view_id);
  return h('span', { class: 'row', style: 'gap:4px;margin-left:auto' },
    sel(S.view_id || '', apply, ['', S.view_id ? '— Clear view —' : '📑 Views'], ...S.views.map(v => [v.id, (v.shared ? '👥 ' : '') + v.name]), ['__save', '+ Save current filters…']),
    cur && (cur.mine || can('settings.manage')) ? h('button', { class: 'btn sec sm', title: 'Delete this view', onclick: guard(async () => { if (!confirm(`Delete the view "${cur.name}"?`)) return; await api('/inbox/views/' + cur.id, 'DELETE'); S.view_id = ''; await loadViews(); renderShell(); }) }, '×') : null);
}
const saveView = guard(async () => {
  const name = prompt('Name this view (e.g. "Urgent sales chats")'); if (!name) return renderShell();
  const shared = can('settings.manage') && confirm('Share this view with the whole team?\n\nOK = shared, Cancel = only me');
  const r = await api('/inbox/views', 'POST', { name, shared, filters: { status: S.filter === 'closed' ? 'closed' : 'open', filter: ['open', 'closed'].includes(S.filter) ? '' : S.filter, q: S.q, tag: S.tag, ...S.f } });
  await loadViews(); S.view_id = String(r.id); toast('View saved'); renderShell();
});
export async function loadViews() { S.views = (await api('/inbox/views').catch(() => ({ views: [] }))).views; }

/** Bulk bar shown while conversations are ticked. */
function bulkBar() {
  const n = S.selected.size; if (!n) return null;
  const run = (action, value) => guard(async () => {
    if (action === 'delete' && !confirm(`Delete ${n} conversation(s) permanently?`)) return;
    const r = await api('/conversations/bulk', 'POST', { ids: [...S.selected], action, value });
    toast(`Updated ${r.updated} conversation(s)${r.errors?.length ? ` · ${r.errors.length} skipped` : ''}`); S.selected.clear(); await loadConvs(); renderShell();
  })();
  return h('div', { class: 'bulk' }, h('b', {}, `${n} selected`),
    can('chats.close') ? h('button', { class: 'btn sec sm', onclick: () => run(S.filter === 'closed' ? 'reopen' : 'close') }, S.filter === 'closed' ? 'Reopen' : '✓ Close') : null,
    h('button', { class: 'btn sec sm', onclick: () => run('read') }, 'Mark read'),
    can('chats.reply') ? sel('', v => v && run('priority', v), ['', 'Priority…'], ...Object.entries(PRIORITY).map(([k, [e, l]]) => [k, `${e} ${l}`.trim()])) : null,
    can('chats.assign') ? sel('', v => v && run('assign', v === 'none' ? null : +v), ['', 'Assign…'], ['none', 'Unassigned'], ...S.members.filter(m => m.can_reply).map(m => [m.id, m.name])) : null,
    can('chats.assign') && mod('departments') && S.departments.length ? sel('', v => v && run('department', v === 'none' ? null : +v), ['', 'Department…'], ...S.departments.map(d => [d.id, d.name]), ['none', 'No department']) : null,
    can('chats.reply') ? h('button', { class: 'btn sec sm', onclick: () => { const t = prompt('Tag to add'); if (t) run('tag', t); } }, '+ Tag') : null,
    can('chats.reply') ? sel('', v => v && run(v === 'wake' ? 'unsnooze' : 'snooze', v === 'wake' ? null : snoozeUntil(v)), ['', 'Snooze…'], ...SNOOZE, ['wake', 'Unsnooze']) : null,
    can('chats.delete') ? h('button', { class: 'btn danger sm', onclick: () => run('delete') }, icon('trash', 14)) : null,
    h('button', { class: 'btn sec sm', onclick: () => { S.selected.clear(); drawList(); } }, 'Cancel'));
}
const SNOOZE = [['1h', '1 hour'], ['3h', '3 hours'], ['tomorrow', 'Tomorrow 9:00'], ['monday', 'Next Monday 9:00'], ['week', '1 week']];
export function snoozeUntil(k) {
  const d = new Date();
  if (k === '1h') return Date.now() + 3600_000; if (k === '3h') return Date.now() + 3 * 3600_000; if (k === 'week') return Date.now() + 7 * 86400_000;
  d.setHours(9, 0, 0, 0); d.setDate(d.getDate() + (k === 'monday' ? ((8 - d.getDay()) % 7 || 7) : 1)); return d.getTime();
}

export function renderInbox(main) {
  api('/tags').then(d => { const changed = JSON.stringify(d.tags) !== JSON.stringify(S.tags); S.tags = d.tags; if (changed && S.view === 'inbox' && !document.querySelector('.filters + .filters') && S.tags.length) renderShell(); }).catch(() => {});
  main.append(h('div', { class: 'inbox' },
    h('div', { class: 'list' },
      h('div', { class: 'top' },
        h('input', { placeholder: 'Search conversations…', value: S.q, oninput: debounce(e => { S.q = e.target.value; loadConvs(); }, 250) }),
        h('div', { class: 'filters' }, ...[['open', 'All open'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['human', 'Needs human'], ['snoozed', '⏰ Snoozed'], ['closed', 'Closed']]
          .map(([k, l]) => h('button', { class: S.filter === k ? 'on' : '', onclick: () => { S.filter = k; S.view_id = ''; S.selected.clear(); renderShell(); } }, l))),
        filterBar(),
        S.tags.length ? h('div', { class: 'filters' }, h('span', { class: 'hint', style: 'margin:0 4px 0 0' }, 'Tags:'), ...S.tags.slice(0, 8).map(t => h('button', { class: S.tag === t.name ? 'on' : '', onclick: () => { S.tag = S.tag === t.name ? '' : t.name; renderShell(); } }, `${t.name} ${t.count}`))) : null),
      h('div', { id: 'bulk' }), h('div', { class: 'items', id: 'items' })),
    h('div', { class: 'chat', id: 'chat' }), h('div', { class: 'side', id: 'side' })));
  loadConvs().then(() => { if (S.cur && S.convs.has(S.cur)) openConv(S.cur); else drawChatEmpty(); });
  drawSide();
  if (!S.viewsLoaded) { S.viewsLoaded = true; loadViews().then(() => S.views.length && S.view === 'inbox' && renderShell()); }
}
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export function drawList() {
  const box = document.getElementById('items'); if (!box) return;
  const list = visibleConvs();
  for (const id of S.selected) if (!S.convs.has(id)) S.selected.delete(id);
  const bb = document.getElementById('bulk'); if (bb) bb.replaceChildren(...[bulkBar()].filter(Boolean));
  const tick = c => h('input', { type: 'checkbox', class: 'tick', checked: S.selected.has(c.id), title: 'Select', onclick: e => { e.stopPropagation(); if (e.target.checked) S.selected.add(c.id); else S.selected.delete(c.id); drawList(); } });
  box.replaceChildren(...(list.length ? list.map(c => h('div', { class: 'item' + (c.id === S.cur ? ' on' : '') + (c.unread ? ' unr' : '') + (S.selected.has(c.id) ? ' picked' : ''), onclick: () => openConv(c.id) },
    tick(c), avEl(c.visitor, c.visitor.online ? h('span', { class: 'on-dot' }) : null),
    h('div', { style: 'min-width:0;flex:1' },
      h('div', { class: 'nm' }, PRIORITY[c.priority]?.[0] && c.priority !== 'normal' ? h('span', { title: PRIORITY[c.priority][1] + ' priority' }, PRIORITY[c.priority][0]) : null, vname(c.visitor), c.spam ? h('span', { class: 'pill bad' }, 'spam') : c.spam_score >= 40 ? h('span', { class: 'pill warn', title: `Spam score ${c.spam_score}` }, '⚠ spam?') : null, c.needs_human ? h('span', { class: 'pill bad' }, 'human') : null, c.unread ? h('span', { class: 'unread' }, c.unread) : null, h('span', { class: 't' }, ago(c.updated))),
      h('div', { class: 'lb' }, c.last_body || '…'), S.sites.length > 1 && !S.site ? h('div', { class: 'hint', style: 'margin:1px 0 0;font-size:11.5px' }, '🌐 ' + (c.site_name || '')) : null,
      h('div', { class: 'row', style: 'gap:5px;margin-top:3px;flex-wrap:wrap' }, c.department_name ? h('span', { class: 'tag dept', style: `border-color:${c.department_color};color:${c.department_color}` }, c.department_name) : null,
        c.snoozed_until ? h('span', { class: 'hint', style: 'margin:0', title: new Date(c.snoozed_until).toLocaleString() }, '⏰ ' + new Date(c.snoozed_until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })) : null,
        ...(c.tags || []).slice(0, 3).map(t => h('span', { class: 'tag' }, t)), c.assignee_name ? h('span', { class: 'hint', style: 'margin:0' }, '→ ' + c.assignee_name) : null)))) : [h('div', { class: 'empty' }, h('div', { class: 'big' }, '🎉'), 'No conversations here')]));
}
export function drawChatEmpty() { const c = document.getElementById('chat'); if (c) c.replaceChildren(h('div', { class: 'empty' }, h('div', { style: 'font-size:40px' }, '💬'), 'Select a conversation')); drawSide(); }
export async function openConv(id) {
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
export function drawHead() {
  const hd = document.getElementById('hd'), c = S.convs.get(S.cur); if (!hd || !c) return;
  const assign = h('select', { disabled: !can('chats.assign'), title: can('chats.assign') ? 'Assign' : 'You cannot reassign chats', onchange: guard(async e => { await api(`/conversations/${c.id}/assign`, 'POST', { agent_id: e.target.value ? +e.target.value : null }); }) },
    h('option', { value: '' }, 'Unassigned'), ...S.members.filter(a => a.can_reply && (!a.site_ids || a.site_ids.includes(c.site_id)) || a.id === c.assignee_id).map(a => h('option', { value: a.id, selected: a.id === c.assignee_id }, a.name)));
  const act = (a, body) => guard(() => api(`/conversations/${c.id}/${a}`, 'POST', body))();
  const prio = can('chats.reply') ? sel(c.priority, v => act('priority', { priority: v }), ...Object.entries(PRIORITY).reverse().map(([k, [e, l]]) => [k, `${e} ${l}`.trim()])) : null;
  if (prio) prio.title = 'Priority';
  const snooze = can('chats.reply') ? sel('', v => { if (v) act('snooze', { until: v === 'wake' ? null : snoozeUntil(v) }); }, ['', c.snoozed_until ? '⏰ Snoozed' : '⏰ Snooze'], ...SNOOZE, ...(c.snoozed_until ? [['wake', 'Unsnooze now']] : [])) : null;
  if (snooze) snooze.title = c.snoozed_until ? 'Snoozed until ' + new Date(c.snoozed_until).toLocaleString() : 'Hide until later';
  const dept = mod('departments') && S.departments.length && can('chats.assign') ? sel(c.department_id || '', v => act('department', { department_id: v ? +v : null }), ['', 'No department'], ...S.departments.map(d => [d.id, d.name])) : null;
  if (dept) dept.title = 'Transfer to department';
  hd.replaceChildren(avEl(c.visitor), h('div', { class: 'grow', style: 'flex:1;min-width:120px' }, h('b', {}, vname(c.visitor)),
    h('div', { class: 'hint' }, c.visitor.online ? '🟢 online' : 'offline', c.bot_active ? ' · 🤖 bot handling' : '', c.department_name ? ' · ' + c.department_name : '')), prio, snooze, dept, assign,
    mod('tickets') && can('tickets.reply') ? h('button', { class: 'btn sec', title: 'Create a ticket from this chat', onclick: () => newTicketDialog(c) }, '🎫') : null,
    can('chats.close') ? h('button', { class: 'btn sec', onclick: guard(() => api(`/conversations/${c.id}/status`, 'POST', { status: c.status === 'open' ? 'closed' : 'open' })) }, c.status === 'open' ? '✓ Close' : 'Reopen') : null,
    can('chats.block') ? h('button', { class: 'btn sec', title: 'Block visitor or report spam', onclick: () => blockDialog(c) }, '🚫') : null,
    h('a', { class: 'btn sec', href: `/api/conversations/${c.id}/transcript`, title: 'Download transcript', style: 'text-decoration:none' }, icon('download')),
    can('chats.delete') ? h('button', { class: 'btn danger', title: 'Delete conversation', onclick: guard(async () => { if (confirm('Delete this conversation permanently?')) await api('/conversations/' + c.id, 'DELETE'); }) }, icon('trash')) : null);
}
export const EMOJI = [...'😀😃😄😁😆😅😂🤣😊😇🙂😉😍🥰😘😋😎🤩🥳🤔🙄😬😢😭😡👍👎👏🙌🙏💪👋🔥❤️💜🎉✨💯✅❌⭐🚀'.matchAll(/\p{Extended_Pictographic}\uFE0F?/gu)].map(m => m[0]);
export function toggleEmoji(btn, ta) {
  const old = document.querySelector('.emo'); if (old) return old.remove();
  const box = h('div', { class: 'emo' }, ...EMOJI.map(e => h('button', { onclick: () => { ta.value += e; ta.focus(); } }, e)));
  btn.closest('.composer').append(box);
}
export function blockDialog(c) {
  const ip = h('input', { type: 'checkbox' }), rep = h('input', { type: 'checkbox', checked: c.spam_score >= 40 }), why = h('input', { placeholder: 'Reason (optional)' });
  const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:440px;max-width:96vw' }, h('h3', {}, 'Block ' + vname(c.visitor)),
    h('p', { class: 'hint' }, 'Blocked visitors no longer see the chat widget on your websites. You can unblock them in Settings → Spam protection.'),
    c.spam_score ? h('div', { class: 'note warn' }, `Automatic spam score for this chat: ${c.spam_score}`) : null,
    h('label', { class: 'inline' }, rep, 'Report as spam (closes the chat and helps the platform catch spam campaigns)'), h('label', { class: 'inline' }, ip, 'Also block their IP address (affects everyone on that network)'),
    h('label', {}, 'Reason'), why,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
      h('button', { class: 'btn danger', onclick: guard(async () => { await api(`/conversations/${c.id}/block`, 'POST', { report: rep.checked, ip: ip.checked, reason: why.value }); md.remove(); toast('Visitor blocked'); }) }, 'Block visitor'))));
  document.body.append(md);
}
export function drawTags() {
  const bar = document.getElementById('tagbar'), c = S.convs.get(S.cur); if (!bar || !c) return;
  const save = guard(async tags => { await api(`/conversations/${c.id}/tags`, 'POST', { tags }); api('/tags').then(d => { S.tags = d.tags; }); });
  if (!can('chats.reply')) return bar.replaceChildren(h('span', { class: 'hint', style: 'margin:0' }, 'Tags'), ...(c.tags || []).map(t => h('span', { class: 'tag' }, t)));
  const inp = h('input', { placeholder: '+ add tag', list: 'taglist', onkeydown: e => { if (e.key === 'Enter' && inp.value.trim()) { save([...(c.tags || []), inp.value.trim()]); inp.value = ''; } } });
  bar.replaceChildren(h('span', { class: 'hint', style: 'margin:0' }, 'Tags'), ...(c.tags || []).map(t => h('span', { class: 'tag' }, t, h('button', { title: 'Remove', onclick: () => save(c.tags.filter(x => x !== t)) }, '×'))), inp,
    h('datalist', { id: 'taglist' }, ...S.tags.map(t => h('option', { value: t.name }))));
}
export function drawMessages() {
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
export function drawTyping() {
  const t = document.getElementById('typing'), c = S.convs.get(S.cur); if (!t || !c) return;
  t.textContent = Date.now() - (S.typing[c.visitor.id] || 0) < 3000 ? vname(c.visitor) + ' is typing…' : '';
}
export function drawSide() {
  const side = document.getElementById('side'); if (!side) return;
  const c = S.convs.get(S.cur);
  if (!c) return side.replaceChildren(h('div', { class: 'empty' }, 'Visitor details appear here'));
  const v = c.visitor;
  const dl = (t, val) => val ? [h('dt', {}, t), h('dd', {}, val)] : [];
  side.replaceChildren(h('h4', {}, 'Visitor'), h('dl', {}, dl('Name', v.name), dl('Email', v.email && h('a', { href: 'mailto:' + v.email }, v.email)), dl('Status', v.online ? 'Online' : 'Offline'),
    dl('Current page', v.page), dl('Visits', String(v.visits)), dl('First seen', new Date(v.created).toLocaleString()), dl('Browser', v.ua?.slice(0, 90))),
    h('h4', {}, 'Conversation'), h('dl', {}, dl('Status', c.status), dl('Started', new Date(c.created).toLocaleString()), dl('Assignee', c.assignee_name || 'Unassigned'), dl('Department', c.department_name), dl('Priority', PRIORITY[c.priority]?.[1]), dl('Snoozed until', c.snoozed_until && new Date(c.snoozed_until).toLocaleString()), dl('Handled by', c.bot_active ? 'Bot' : 'Human')));
}

// ---------- visitors ----------
