// Settings → Departments & routing: teams, automatic assignment, concurrent-chat limits, widget picker.
import { S, api, appendTo, avEl, guard, h, toast } from './core.js';
import { renderShell } from './shell.js';

const MODES = {
  manual: ['Manual', 'Nobody is auto-assigned. Everyone who can reply is notified and picks chats from the inbox.'],
  round_robin: ['Round robin', 'Chats rotate between available agents: whoever got one longest ago is next.'],
  least_busy: ['Least busy', 'Each chat goes to the available agent with the fewest open chats.'],
};

export async function renderDepartments(page) {
  const [d, mem] = await Promise.all([api('/departments'), api('/members')]);
  S.departments = d.departments; S.routing = d.routing; S.members = mem.members;
  const r = d.routing, repliers = S.members.filter(m => m.can_reply);
  const save = patch => guard(async () => { const x = await api('/routing', 'PUT', patch); S.routing = x.routing; toast(x.routed ? `Saved · ${x.routed} waiting chat(s) assigned` : 'Saved'); renderShell(); });
  const maxIn = h('input', { type: 'number', min: 0, max: 50, value: r.maxChats, style: 'width:90px' });

  appendTo(page, h('div', { class: 'grid2', style: 'align-items:start' },
    h('div', { class: 'card' }, h('h3', {}, 'Automatic assignment'),
      h('p', { class: 'hint' }, 'Applies to new chats when the bot is off and to chats the bot hands over. Only teammates who are signed in to the dashboard, set to Available, and allowed on the website receive chats.'),
      ...Object.entries(MODES).map(([k, [label, desc]]) => h('label', { class: 'opt' },
        h('input', { type: 'radio', name: 'mode', checked: r.assignmentMode === k, onchange: save({ assignmentMode: k }) }), h('div', {}, h('b', {}, label), h('div', { class: 'hint', style: 'margin:0' }, desc)))),
      h('label', {}, 'Max open chats per agent'), h('div', { class: 'row' }, maxIn, h('button', { class: 'btn sec sm', onclick: () => save({ maxChats: +maxIn.value })() }, 'Save'), h('span', { class: 'hint', style: 'margin:0' }, '0 = no limit. Chats beyond the limit wait in the queue.')),
      h('label', { class: 'inline', style: 'margin-top:14px' }, h('input', { type: 'checkbox', checked: r.widgetDepartments, onchange: e => save({ widgetDepartments: e.target.checked })() }),
        'Let visitors choose a department in the chat widget (public departments only)')),
    h('div', { class: 'card' }, h('h3', {}, 'Team availability'),
      h('p', { class: 'hint' }, 'Each teammate switches between Available and Away under their name in the sidebar.'),
      ...repliers.map(m => h('div', { class: 'check' }, avEl({ id: m.email || m.name, name: m.name }), h('div', { style: 'flex:1' }, h('b', {}, m.name), h('div', { class: 'hint', style: 'margin:0' }, m.role)),
        h('span', { class: 'pill ' + (!m.online ? '' : m.status === 'away' ? 'warn' : 'ok') }, !m.online ? 'offline' : m.status === 'away' ? 'away' : 'available'))))));

  const list = h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Departments'), h('button', { class: 'btn', onclick: () => edit(null) }, '+ New department')),
    h('p', { class: 'hint' }, 'Group teammates into teams such as Sales, Support or Billing. Chats with a department are routed to — and notify — its members only. Agents can transfer chats between departments, and chatbot flows can hand over to a specific one.'),
    ...(d.departments.length ? d.departments.map(dep => h('div', { class: 'dept-row' }, h('span', { class: 'dept-sw', style: `background:${dep.color}` }),
      h('div', { style: 'flex:1' }, h('b', {}, dep.name), dep.public ? null : h('span', { class: 'pill', style: 'margin-left:6px' }, 'internal'),
        dep.description ? h('div', { class: 'hint', style: 'margin:0' }, dep.description) : null,
        h('div', { class: 'hint', style: 'margin:2px 0 0' }, `${dep.members.length} member(s): ${dep.members.map(id => S.members.find(m => m.id === id)?.name).filter(Boolean).join(', ') || 'nobody yet — chats go to everyone'} · ${dep.open} open chat(s)`)),
      h('button', { class: 'btn sec sm', onclick: () => edit(dep) }, 'Edit'),
      h('button', { class: 'btn danger sm', onclick: guard(async () => { if (!confirm(`Delete ${dep.name}? Its chats stay, without a department.`)) return; await api('/departments/' + dep.id, 'DELETE'); toast('Deleted'); renderShell(); }) }, 'Delete')))
      : [h('div', { class: 'empty' }, 'No departments yet')]));
  page.append(list);

  function edit(dep) {
    const name = h('input', { value: dep?.name || '', placeholder: 'e.g. Sales' }), desc = h('input', { value: dep?.description || '', placeholder: 'Shown to your team (optional)' });
    const color = h('input', { type: 'color', value: dep?.color || '#6366f1', style: 'width:60px;padding:2px' }), pub = h('input', { type: 'checkbox', checked: dep ? dep.public : true });
    const boxes = repliers.map(m => [m.id, h('input', { type: 'checkbox', checked: !!dep?.members.includes(m.id) })]);
    const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:480px;max-width:96vw;max-height:90vh;overflow:auto' }, h('h3', {}, dep ? 'Edit department' : 'New department'),
      h('label', {}, 'Name'), name, h('label', {}, 'Description'), desc, h('label', {}, 'Color'), color,
      h('label', { class: 'inline' }, pub, 'Visitors can pick it in the chat widget'),
      h('label', {}, 'Members'), h('div', { class: 'hint' }, 'Only roles that can reply to chats are listed.'),
      ...boxes.map(([id, b]) => h('label', { class: 'inline' }, b, S.members.find(m => m.id === id).name)),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
        h('button', { class: 'btn', onclick: guard(async () => {
          const body = { name: name.value, description: desc.value, color: color.value, public: pub.checked, members: boxes.filter(([, b]) => b.checked).map(([id]) => id) };
          await api(dep ? '/departments/' + dep.id : '/departments', dep ? 'PUT' : 'POST', body); md.remove(); toast('Saved'); renderShell();
        }) }, 'Save'))));
    document.body.append(md); name.focus();
  }
}
