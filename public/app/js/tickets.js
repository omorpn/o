// Tickets: list with status tabs and filters, ticket thread with replies and notes, properties, SLA, history, merge, bulk actions.
import { S, ago, api, appendTo, can, guard, h, icon, mod, toast } from './core.js';
import { renderShell } from './shell.js';
import { PRIORITY } from './inbox.js';

export const T = { list: new Map(), counts: {}, cur: null, detail: null, tab: 'active', view: '', q: '', f: { priority: '', assignee: '', department: '' }, selected: new Set(), settings: null };
const STATUS = { open: ['Open', 'bad'], pending: ['Pending', 'warn'], solved: ['Solved', 'ok'], closed: ['Closed', ''] };
const SLA = { breached: ['SLA breached', 'bad'], due_soon: ['Due soon', 'warn'], ok: ['On track', 'ok'] };
const sel = (value, onchange, ...opts) => h('select', { class: 'sm', onchange: e => onchange(e.target.value) }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, l)));
const pill = (txt, cls) => h('span', { class: 'pill ' + (cls || '') }, txt);
const when = t => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const left = t => { const m = Math.round((t - Date.now()) / 60000), a = Math.abs(m), s = a < 60 ? a + 'm' : a < 1440 ? Math.round(a / 60) + 'h' : Math.round(a / 1440) + 'd'; return m < 0 ? s + ' overdue' : 'in ' + s; };
const repliers = () => S.members.filter(m => m.can_reply);

export async function loadTickets() {
  const p = new URLSearchParams({ status: T.tab });
  if (T.view) p.set('view', T.view); if (T.q) p.set('q', T.q);
  for (const [k, v] of Object.entries(T.f)) if (v) p.set(k, v);
  const d = await api('/tickets?' + p);
  T.list = new Map(d.tickets.map(t => [t.id, t])); T.counts = d.counts;
  drawTicketList();
}
const matches = t => (T.tab === 'all' || (T.tab === 'active' ? ['open', 'pending'].includes(t.status) : t.status === T.tab))
  && (!T.view || (T.view === 'mine' ? t.assignee_id === S.me.id : T.view === 'unassigned' ? !t.assignee_id : t.sla === 'breached'))
  && (!T.f.priority || t.priority === T.f.priority) && (!T.f.assignee || String(t.assignee_id ?? 'none') === T.f.assignee) && (!T.f.department || String(t.department_id ?? 'none') === T.f.department);

/** Realtime: a ticket changed or appeared. */
export function onTicket(t) {
  if (matches(t)) T.list.set(t.id, t); else T.list.delete(t.id);
  if (S.view !== 'tickets') return;
  drawTicketList();
  if (T.cur === t.id && T.detail) { T.detail.ticket = { ...T.detail.ticket, ...t }; drawProps(); drawTicketHead(); }
}
export function onTicketMessage({ ticket_id, message }) {
  if (S.view === 'tickets' && T.cur === ticket_id && T.detail && !T.detail.messages.some(m => m.id === message.id)) { T.detail.messages.push(message); drawThread(); }
}
export function onTicketDeleted({ id }) { T.list.delete(id); if (T.cur === id) { T.cur = null; T.detail = null; } if (S.view === 'tickets') renderShell(); }

export function renderTickets(main) {
  const tab = (k, l, n) => h('button', { class: T.tab === k && !T.view ? 'on' : '', onclick: () => { T.tab = k; T.view = ''; T.selected.clear(); renderShell(); } }, l, n ? h('span', { class: 'n' }, n) : null);
  const view = (k, l, n) => h('button', { class: T.view === k ? 'on' : '', onclick: () => { T.view = k; T.tab = 'active'; T.selected.clear(); renderShell(); } }, l, n ? h('span', { class: 'n' }, n) : null);
  const setF = (k, v) => { T.f[k] = v; renderShell(); };
  const c = T.counts;
  main.append(h('div', { class: 'inbox tickets' },
    h('div', { class: 'list' },
      h('div', { class: 'top' },
        h('div', { class: 'row' }, h('input', { placeholder: 'Search subject, requester or #number…', value: T.q, oninput: debounce(e => { T.q = e.target.value; loadTickets(); }, 250) }),
          can('tickets.reply') ? h('button', { class: 'btn', title: 'New ticket', onclick: () => newTicketDialog() }, icon('plus', 15)) : null),
        h('div', { class: 'filters' }, tab('active', 'Active', (c.open || 0) + (c.pending || 0)), tab('open', 'Open', c.open), tab('pending', 'Pending', c.pending), tab('solved', 'Solved', c.solved), tab('closed', 'Closed'), tab('all', 'All')),
        h('div', { class: 'filters' }, view('mine', 'Mine', c.mine), view('unassigned', 'Unassigned', c.unassigned), view('overdue', '⏱ Overdue', c.overdue)),
        h('div', { class: 'filters fbar' },
          sel(T.f.priority, v => setF('priority', v), ['', 'Any priority'], ...Object.entries(PRIORITY).reverse().map(([k, [e, l]]) => [k, `${e} ${l}`.trim()])),
          can('tickets.view_all') ? sel(T.f.assignee, v => setF('assignee', v), ['', 'Anyone'], ['none', 'Unassigned'], ...repliers().map(m => [m.id, m.name])) : null,
          mod('departments') && S.departments.length ? sel(T.f.department, v => setF('department', v), ['', 'All departments'], ...S.departments.map(d => [d.id, d.name]), ['none', 'No department']) : null)),
      h('div', { id: 'tbulk' }), h('div', { class: 'items', id: 'titems' })),
    h('div', { class: 'chat', id: 'tchat' }), h('div', { class: 'side', id: 'tside' })));
  loadTickets().then(() => { if (T.cur) openTicket(T.cur); else drawEmpty(); });
  if (!T.settings) api('/tickets/settings').then(s => { T.settings = s; }).catch(() => {});
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function drawEmpty() {
  document.getElementById('tchat')?.replaceChildren(h('div', { class: 'empty' }, h('div', { style: 'font-size:40px' }, '🎫'), 'Select a ticket', can('tickets.reply') ? h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: () => newTicketDialog() }, '+ New ticket')) : null));
  document.getElementById('tside')?.replaceChildren(h('div', { class: 'empty' }, 'Ticket details appear here'));
}

export function drawTicketList() {
  const box = document.getElementById('titems'); if (!box) return;
  for (const id of T.selected) if (!T.list.has(id)) T.selected.delete(id);
  document.getElementById('tbulk')?.replaceChildren(...[bulkBar()].filter(Boolean));
  const list = [...T.list.values()].sort((a, b) => (PR[b.priority] - PR[a.priority]) || b.updated - a.updated);
  box.replaceChildren(...(list.length ? list.map(t => h('div', { class: 'item' + (t.id === T.cur ? ' on' : '') + (T.selected.has(t.id) ? ' picked' : ''), onclick: () => openTicket(t.id) },
    h('input', { type: 'checkbox', class: 'tick', checked: T.selected.has(t.id), onclick: e => { e.stopPropagation(); e.target.checked ? T.selected.add(t.id) : T.selected.delete(t.id); drawTicketList(); } }),
    h('div', { style: 'min-width:0;flex:1' },
      h('div', { class: 'nm' }, t.priority !== 'normal' ? h('span', { title: PRIORITY[t.priority][1] }, PRIORITY[t.priority][0]) : null, h('span', { class: 'tnum' }, '#' + t.number), t.channel === 'email' ? h('span', { title: 'Email' }, '✉️') : t.channel === 'chat' ? h('span', { title: 'From chat' }, '💬') : null, h('span', { class: 'subj' }, t.subject), h('span', { class: 't' }, ago(t.updated))),
      h('div', { class: 'lb' }, (t.last_message?.author_type === 'customer' ? '↩ ' : '') + (t.last_message?.body || t.requester_email || '…')),
      h('div', { class: 'row', style: 'gap:5px;margin-top:4px;flex-wrap:wrap' }, pill(STATUS[t.status][0], STATUS[t.status][1]), t.sla && t.sla !== 'ok' ? pill(SLA[t.sla][0], SLA[t.sla][1]) : null,
        t.department_name ? h('span', { class: 'tag dept', style: `border-color:${t.department_color};color:${t.department_color}` }, t.department_name) : null,
        ...t.tags.slice(0, 2).map(x => h('span', { class: 'tag' }, x)), h('span', { class: 'hint', style: 'margin:0' }, t.assignee_name ? '→ ' + t.assignee_name : 'unassigned'))))) : [h('div', { class: 'empty' }, h('div', { class: 'big' }, '🎉'), 'No tickets here')]));
}
const PR = { urgent: 3, high: 2, normal: 1, low: 0 };

function bulkBar() {
  const n = T.selected.size; if (!n) return null;
  const run = (action, value) => guard(async () => {
    if (action === 'delete' && !confirm(`Delete ${n} ticket(s) permanently?`)) return;
    const r = await api('/tickets/bulk', 'POST', { ids: [...T.selected], action, value }); toast(`Updated ${r.updated} ticket(s)`); T.selected.clear(); await loadTickets();
  })();
  return h('div', { class: 'bulk' }, h('b', {}, `${n} selected`),
    sel('', v => v && run('status', v), ['', 'Status…'], ...Object.entries(STATUS).map(([k, [l]]) => [k, l])),
    sel('', v => v && run('priority', v), ['', 'Priority…'], ...Object.entries(PRIORITY).map(([k, [e, l]]) => [k, `${e} ${l}`.trim()])),
    sel('', v => v && run('assign', v === 'none' ? null : +v), ['', 'Assign…'], ['none', 'Unassigned'], ...repliers().map(m => [m.id, m.name])),
    mod('departments') && S.departments.length ? sel('', v => v && run('department', v === 'none' ? null : +v), ['', 'Department…'], ...S.departments.map(d => [d.id, d.name]), ['none', 'No department']) : null,
    h('button', { class: 'btn sec sm', onclick: () => { const t = prompt('Tag to add'); if (t) run('tag', t); } }, '+ Tag'),
    can('tickets.manage') ? h('button', { class: 'btn danger sm', onclick: () => run('delete') }, icon('trash', 14)) : null,
    h('button', { class: 'btn sec sm', onclick: () => { T.selected.clear(); drawTicketList(); } }, 'Cancel'));
}

export async function openTicket(id) {
  T.cur = id; drawTicketList();
  const chat = document.getElementById('tchat'); if (!chat) return;
  T.detail = await api('/tickets/' + id).catch(e => { toast(e.message); T.cur = null; return null; });
  if (!T.detail) return drawEmpty();
  const t = T.detail.ticket;
  const ta = h('textarea', { placeholder: t.requester_email ? `Reply to ${t.requester_email}…` : 'Internal note…' });
  let note = !t.requester_email;
  const modeBtn = (isNote, label) => h('button', { class: (note === isNote ? 'on ' : '') + (isNote ? 'note' : ''), disabled: !isNote && !t.requester_email, title: !isNote && !t.requester_email ? 'No requester email on this ticket' : '',
    onclick: e => { note = isNote; ta.placeholder = note ? 'Internal note — only your team sees this' : `Reply to ${t.requester_email}…`; e.target.parentNode.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.target.classList.add('on'); } }, label);
  const send = status => guard(async () => {
    const body = ta.value.trim(); if (!body) return toast('Write something first');
    const r = await api(`/tickets/${t.id}/reply`, 'POST', { body, note, ...(status && { status }) }); ta.value = '';
    if (!T.detail.messages.some(m => m.id === r.message.id)) T.detail.messages.push(r.message);
    T.detail.ticket = r.ticket; drawThread(); drawProps(); drawTicketHead();
  });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send()(); } });
  const closed = t.status === 'closed';
  chat.replaceChildren(h('div', { class: 'hd', id: 'thd' }), h('div', { class: 'msgs', id: 'tmsgs' }),
    !can('tickets.reply') ? h('div', { class: 'composer hint', style: 'text-align:center;padding:16px' }, '👁 Read-only — your role can view tickets but not reply.')
      : closed ? h('div', { class: 'composer hint', style: 'text-align:center;padding:16px' }, 'This ticket is closed. ', h('a', { href: '#', onclick: guard(async e => { e.preventDefault(); await api('/tickets/' + t.id, 'PUT', { status: 'open' }); openTicket(t.id); }) }, 'Reopen it'), ' to reply.')
      : h('div', { class: 'composer' }, h('div', { class: 'modes' }, modeBtn(false, 'Reply to customer'), modeBtn(true, 'Internal note')), ta,
        h('div', { class: 'row', style: 'margin-top:6px;justify-content:space-between' }, h('span', { class: 'hint', style: 'margin:0' }, 'Ctrl+Enter to send'),
          h('div', { class: 'row', style: 'gap:6px' }, h('button', { class: 'btn sec', onclick: () => send('solved')() }, 'Send & solve'), h('button', { class: 'btn', onclick: () => send()() }, 'Send')))));
  drawTicketHead(); drawThread(); drawProps();
}
function drawTicketHead() {
  const hd = document.getElementById('thd'), t = T.detail?.ticket; if (!hd || !t) return;
  hd.replaceChildren(h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'row', style: 'gap:8px' }, h('span', { class: 'tnum' }, '#' + t.number), h('b', { class: 'subj', title: 'Click to rename', style: 'cursor:text',
    onclick: guard(async () => { if (!can('tickets.reply')) return; const s = prompt('Subject', t.subject); if (s && s !== t.subject) { await api('/tickets/' + t.id, 'PUT', { subject: s }); } }) }, t.subject)),
    h('div', { class: 'hint', style: 'margin:2px 0 0' }, `${t.requester_name || t.requester_email || 'No requester'}${t.requester_name && t.requester_email ? ' <' + t.requester_email + '>' : ''} · via ${t.channel} · ${when(t.created)}`)),
    pill(STATUS[t.status][0], STATUS[t.status][1]),
    can('tickets.manage') ? h('button', { class: 'btn sec', title: 'Merge into another ticket', onclick: () => mergeDialog(t) }, 'Merge') : null,
    can('tickets.manage') ? h('button', { class: 'btn danger', title: 'Delete ticket', onclick: guard(async () => { if (confirm(`Delete ticket #${t.number}?`)) { await api('/tickets/' + t.id, 'DELETE'); } }) }, icon('trash')) : null);
}
function drawThread() {
  const box = document.getElementById('tmsgs'); if (!box || !T.detail) return;
  box.replaceChildren(...T.detail.messages.map(m => m.kind === 'system' ? h('div', { class: 'sysmsg' }, m.body)
    : h('div', { class: 'tmsg ' + (m.kind === 'note' ? 'note' : m.author_type) },
      h('div', { class: 'tmeta' }, h('b', {}, m.author_name || (m.author_type === 'customer' ? 'Customer' : 'Agent')), m.author_email ? h('span', { class: 'hint', style: 'margin:0' }, ' <' + m.author_email + '>') : null,
        m.kind === 'note' ? pill('internal note', 'warn') : null, h('span', { class: 'hint', style: 'margin:0 0 0 auto' }, when(m.created))),
      h('div', { class: 'tbody' }, m.body),
      m.attachments?.length ? h('div', { class: 'row', style: 'gap:6px;margin-top:6px;flex-wrap:wrap' }, ...m.attachments.map(a => h('a', { href: a.url, target: '_blank', rel: 'noopener', class: 'tag' }, '📎 ' + a.name))) : null)));
  box.scrollTop = box.scrollHeight;
}
function drawProps() {
  const side = document.getElementById('tside'), d = T.detail, t = d?.ticket; if (!side || !t) return;
  const edit = can('tickets.reply') && t.status !== 'closed';
  const put = patch => guard(async () => { const r = await api('/tickets/' + t.id, 'PUT', patch); const ev = await api('/tickets/' + t.id); T.detail.ticket = r.ticket; T.detail.events = ev.events; drawProps(); drawTicketHead(); })();
  // keep whatever the agent is typing when the panel re-renders
  const typing = side.contains(document.activeElement) && document.activeElement.dataset.k ? [document.activeElement.dataset.k, document.activeElement.value] : null;
  const row = (label, ctl) => [h('dt', {}, label), h('dd', {}, ctl)];
  const fields = T.settings?.fields || [];
  const tagIn = h('input', { placeholder: '+ add tag', onkeydown: e => { if (e.key === 'Enter' && tagIn.value.trim()) put({ tags: [...t.tags, tagIn.value.trim()] }); } });
  side.replaceChildren();
  appendTo(side,
    h('h4', {}, 'Properties'),
    h('dl', { class: 'props' },
      row('Status', can('tickets.reply') ? sel(t.status, v => put({ status: v }), ...Object.entries(STATUS).map(([k, [l]]) => [k, l])) : STATUS[t.status][0]),
      row('Priority', edit ? sel(t.priority, v => put({ priority: v }), ...Object.entries(PRIORITY).reverse().map(([k, [e, l]]) => [k, `${e} ${l}`.trim()])) : PRIORITY[t.priority][1]),
      row('Assignee', edit ? sel(t.assignee_id ?? '', v => put({ assignee_id: v ? +v : null }), ['', 'Unassigned'], ...repliers().map(m => [m.id, m.name])) : t.assignee_name || 'Unassigned'),
      mod('departments') && S.departments.length ? row('Department', edit ? sel(t.department_id ?? '', v => put({ department_id: v ? +v : null }), ['', 'None'], ...S.departments.map(x => [x.id, x.name])) : t.department_name || 'None') : null,
      ...fields.map(f => row(f.label, !edit ? String(t.custom[f.key] ?? '—')
        : f.type === 'select' ? sel(t.custom[f.key] ?? '', v => put({ custom: { [f.key]: v || null } }), ['', '—'], ...f.options.map(o => [o, o]))
        : f.type === 'checkbox' ? h('input', { type: 'checkbox', checked: !!t.custom[f.key], style: 'width:auto', onchange: e => put({ custom: { [f.key]: e.target.checked } }) })
        : h('input', { type: f.type === 'number' ? 'number' : 'text', value: t.custom[f.key] ?? '', class: 'sm', 'data-k': f.key, onchange: e => put({ custom: { [f.key]: e.target.value || null } }) })))),
    h('h4', {}, 'Tags'), h('div', { class: 'row', style: 'gap:5px;flex-wrap:wrap' }, ...t.tags.map(x => h('span', { class: 'tag' }, x, edit ? h('button', { onclick: () => put({ tags: t.tags.filter(y => y !== x) }) }, '×') : null)), edit ? tagIn : null),
    h('h4', {}, 'SLA'), h('dl', {},
      ...(t.first_response_due ? [h('dt', {}, 'First response'), h('dd', {}, t.first_response_at ? '✅ ' + when(t.first_response_at) : left(t.first_response_due))] : []),
      ...(t.due_at ? [h('dt', {}, 'Resolution'), h('dd', {}, t.solved_at ? '✅ ' + when(t.solved_at) : left(t.due_at))] : []),
      t.sla ? [h('dt', {}, 'State'), h('dd', {}, pill(SLA[t.sla][0], SLA[t.sla][1]))] : null),
    t.conversation_id ? [h('h4', {}, 'Source'), h('a', { href: '#', onclick: e => { e.preventDefault(); S.view = 'inbox'; S.filter = 'open'; S.cur = t.conversation_id; renderShell(); } }, '💬 Open the original chat')] : null,
    d.merged.length ? [h('h4', {}, 'Merged in'), ...d.merged.map(m => h('div', { class: 'hint' }, `#${m.number} ${m.subject}`))] : null,
    d.others.length ? [h('h4', {}, 'Other tickets from this requester'), ...d.others.map(o => h('div', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); openTicket(o.id); } }, `#${o.number} ${o.subject}`), ' ', pill(STATUS[o.status][0], STATUS[o.status][1])))] : null,
    h('h4', {}, 'History'), h('div', { class: 'tevents' }, ...d.events.slice().reverse().map(e => h('div', {}, h('b', {}, e.user_name), ' ', e.action === 'changed' ? e.detail : `${e.action.replace('_', ' ')}${e.detail ? ' — ' + e.detail : ''}`, h('div', { class: 'hint', style: 'margin:0' }, ago(e.created))))));
  if (typing) { const el = side.querySelector(`[data-k="${typing[0]}"]`); if (el) { el.value = typing[1]; el.focus(); } }
}

function mergeDialog(t) {
  const q = h('input', { placeholder: 'Ticket number, e.g. 12' });
  const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:420px;max-width:96vw' }, h('h3', {}, `Merge #${t.number} into…`),
    h('p', { class: 'hint' }, 'All messages move to the other ticket and this one is closed. This cannot be undone.'), h('label', {}, 'Target ticket number'), q,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
      h('button', { class: 'btn danger', onclick: guard(async () => {
        const n = Number(q.value.replace('#', '')); const found = (await api('/tickets?status=all&q=' + n)).tickets.find(x => x.number === n);
        if (!found) throw new Error(`Ticket #${q.value} not found`);
        const r = await api(`/tickets/${t.id}/merge`, 'POST', { into: found.id }); md.remove(); toast(`Merged into #${r.ticket.number}`); T.cur = r.ticket.id; renderShell();
      }) }, 'Merge'))));
  document.body.append(md); q.focus();
}

/** New ticket form; `conv` pre-fills it from a live chat (creates the ticket with the transcript attached). */
export function newTicketDialog(conv = null) {
  const subject = h('input', { placeholder: 'Short summary', value: conv ? (conv.last_body || '').slice(0, 120) : '' }), body = h('textarea', { rows: 4, placeholder: conv ? 'Note for the team (optional) — the chat transcript is attached automatically' : 'Describe the issue' });
  const email = h('input', { type: 'email', placeholder: 'customer@example.com', value: conv?.visitor?.email || '' }), name = h('input', { placeholder: 'Customer name', value: conv?.visitor?.name || '' });
  const prio = sel(conv?.priority || 'normal', () => {}, ...Object.entries(PRIORITY).reverse().map(([k, [e, l]]) => [k, `${e} ${l}`.trim()]));
  const asg = sel(conv ? S.me.id : '', () => {}, ['', 'Unassigned'], ...repliers().map(m => [m.id, m.name]));
  const dep = mod('departments') && S.departments.length ? sel(conv?.department_id ?? '', () => {}, ['', 'No department'], ...S.departments.map(d => [d.id, d.name])) : null;
  const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:520px;max-width:96vw;max-height:92vh;overflow:auto' }, h('h3', {}, conv ? '🎫 Create ticket from this chat' : 'New ticket'),
    h('label', {}, 'Subject'), subject, conv ? null : [h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Requester email'), email), h('div', {}, h('label', {}, 'Requester name'), name))],
    h('label', {}, conv ? 'Internal note' : 'Description'), body,
    h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Priority'), prio), h('div', {}, h('label', {}, 'Assignee'), asg)), dep ? [h('label', {}, 'Department'), dep] : null,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
      h('button', { class: 'btn', onclick: guard(async () => {
        const common = { subject: subject.value, priority: prio.value, assignee_id: asg.value ? +asg.value : null, ...(dep && { department_id: dep.value ? +dep.value : null }) };
        const r = conv ? await api(`/conversations/${conv.id}/ticket`, 'POST', { ...common, note: body.value })
          : await api('/tickets', 'POST', { ...common, body: body.value, requester_email: email.value, requester_name: name.value });
        md.remove(); toast(`Ticket #${r.ticket.number} created`);
        if (!conv) { T.cur = r.ticket.id; S.view = 'tickets'; renderShell(); }
      }) }, 'Create ticket'))));
  document.body.append(md); subject.focus();
}

// ---------- settings tab ----------
export async function renderTicketSettings(page) {
  const s = await api('/tickets/settings'); T.settings = s;
  const manage = can('tickets.manage');
  const inputs = Object.fromEntries(['urgent', 'high', 'normal', 'low'].map(p => [p, s.sla[p].map(v => h('input', { type: 'number', min: 0, value: v, style: 'width:90px', disabled: !manage }))]));
  const close = h('input', { type: 'number', min: 0, max: 90, value: s.autoCloseDays, style: 'width:90px', disabled: !manage });
  const fields = s.fields.map(f => ({ ...f }));
  const fbox = h('div');
  const drawFields = () => fbox.replaceChildren(...fields.map((f, i) => h('div', { class: 'row', style: 'margin-bottom:6px' },
    h('input', { value: f.label, placeholder: 'Label', oninput: e => { f.label = e.target.value; } }),
    sel(f.type, v => { f.type = v; drawFields(); }, ['text', 'Text'], ['number', 'Number'], ['select', 'Dropdown'], ['checkbox', 'Checkbox']),
    f.type === 'select' ? h('input', { value: (f.options || []).join(', '), placeholder: 'Options, comma separated', oninput: e => { f.options = e.target.value.split(',').map(x => x.trim()).filter(Boolean); } }) : null,
    h('button', { class: 'btn sec sm', onclick: () => { fields.splice(i, 1); drawFields(); } }, '−'))),
    fields.length < 20 ? h('button', { class: 'btn sec sm', onclick: () => { fields.push({ label: '', type: 'text' }); drawFields(); } }, '+ Add field') : null);
  drawFields();
  appendTo(page, h('div', { class: 'grid2', style: 'align-items:start' },
    h('div', { class: 'card' }, h('h3', {}, 'Response targets (SLA)'), h('p', { class: 'hint' }, 'Hours from when the ticket is created. 0 = no target. Breaches are flagged in the list and notify the assignee (or the team when unassigned).'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Priority'), h('th', {}, 'First response (h)'), h('th', {}, 'Resolution (h)'))),
        h('tbody', {}, ...Object.entries(inputs).map(([p, [a, b]]) => h('tr', {}, h('td', {}, `${PRIORITY[p][0]} ${PRIORITY[p][1]}`), h('td', {}, a), h('td', {}, b))))),
      h('label', {}, 'Close solved tickets automatically after (days)'), close, h('div', { class: 'hint' }, '0 = never. Closed tickets are read-only.'),
      manage ? h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => {
        T.settings = await api('/tickets/settings', 'PUT', { sla: Object.fromEntries(Object.entries(inputs).map(([p, [a, b]]) => [p, [+a.value, +b.value]])), autoCloseDays: +close.value }); toast('Saved');
      }) }, 'Save targets') : null),
    h('div', { class: 'card' }, h('h3', {}, 'Custom fields'), h('p', { class: 'hint' }, 'Extra properties on every ticket, e.g. order number, sales channel or amount.'), fbox,
      manage ? h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { T.settings = await api('/tickets/settings', 'PUT', { fields }); toast('Saved'); renderShell(); }) }, 'Save fields') : null)));
}
