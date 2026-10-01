import { api, appendTo, can, guard, h, icon } from './core.js';
import { siteBar } from './dashboard.js';
import { renderShell } from './shell.js';

// ---------- triggers ----------
export async function renderTriggers(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const admin = can('bot.manage'), { triggers } = await api('/triggers');
  appendTo(page, h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h2', { class: 'page-h grow', style: 'margin:0' }, 'Triggers'), admin ? h('button', { class: 'btn', onclick: () => triggerEditor(null) }, icon('plus', 16), 'New trigger') : null),
    siteBar(), h('p', { class: 'hint', style: 'margin:0 0 18px' }, 'Start the conversation for visitors: show a message after a delay on pages whose URL contains some text, or open the chat automatically.'),
    ...(triggers.length ? triggers.map(t => h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, t.name), ' ', h('span', { class: 'pill' + (t.enabled ? ' ok' : '') }, t.enabled ? 'active' : 'paused'), t.open_chat ? h('span', { class: 'pill warn' }, 'auto-opens chat') : null,
      h('div', { class: 'hint' }, `Page URL ${t.url_contains ? 'contains "' + t.url_contains + '"' : 'any page'} · after ${t.delay}s`), h('div', { style: 'margin-top:6px' }, '💬 ' + t.message)),
      admin ? [h('button', { class: 'btn sec sm', onclick: () => triggerEditor(t) }, 'Edit'), h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm('Delete trigger?')) { await api('/triggers/' + t.id, 'DELETE'); renderShell(); } }) }, 'Delete')] : null)))
      : [h('div', { class: 'card empty' }, h('div', { class: 'big' }, '⚡'), 'No triggers yet')]));
}
export function triggerEditor(t) {
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

