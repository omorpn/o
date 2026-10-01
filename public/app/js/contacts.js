import { S, ago, api, appendTo, avEl, guard, h, icon, toast, vname } from './core.js';
import { debounce } from './inbox.js';
import { renderShell } from './shell.js';

// ---------- contacts ----------
export async function renderContacts(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const box = h('div', { class: 'card', style: 'padding:0' });
  const load = guard(async q => {
    const { contacts } = await api('/contacts?q=' + encodeURIComponent(q || ''));
    box.replaceChildren(contacts.length ? h('table', {}, h('thead', {}, h('tr', {}, ...['Contact', 'Email', 'Chats', 'Visits', 'Last seen'].map(x => h('th', {}, x)))),
      h('tbody', {}, ...contacts.map(c => h('tr', { style: 'cursor:pointer', onclick: () => openContact(c.id) }, h('td', {}, h('div', { class: 'row' }, avEl(c), h('b', {}, vname(c)), c.online ? h('span', { class: 'pill ok' }, 'online') : null)),
        h('td', {}, c.email || '—'), h('td', {}, c.conversations), h('td', {}, c.visits), h('td', {}, ago(c.last_seen) + ' ago')))))
      : h('div', { class: 'empty' }, h('div', { class: 'big' }, '👥'), 'No contacts yet. Visitors appear here once they share a name or email.'));
  });
  appendTo(page, h('div', { class: 'row', style: 'margin-bottom:18px' }, h('h2', { class: 'page-h grow', style: 'margin:0' }, 'Contacts'),
    h('input', { placeholder: 'Search name or email…', style: 'width:260px', oninput: debounce(e => load(e.target.value), 250) }),
    h('a', { class: 'btn sec', href: '/api/export/contacts.csv', style: 'text-decoration:none' }, icon('download', 16), 'Export CSV')), box);
  load('');
}
export const openContact = guard(async id => {
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

