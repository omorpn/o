import { S, ago, api, guard, h, toast, vname } from './core.js';
import { renderShell } from './shell.js';

export async function renderVisitors(main) {
  main.append(h('div', { class: 'page' }, h('div', { class: 'row', style: 'margin-bottom:16px' }, h('h2', { class: 'page-h grow', style: 'margin:0' }, 'Live visitors')), h('div', { class: 'card', id: 'vis', style: 'padding:0' })));
  const d = await api('/visitors'); S.visitors = new Map(d.visitors.map(v => [v.id, v])); drawVisitors();
}
export function drawVisitors() {
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

