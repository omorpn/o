import { S, api, appendTo, can, guard, h, toast, mod } from './core.js';
import { siteBar } from './dashboard.js';
import { renderShell } from './shell.js';

// ---------- chatbot ----------
export async function renderBot(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const off = () => Promise.resolve({});
  const [{ rules = [] }, { settings }, { kb = [] }, { flows = [] }] = await Promise.all([mod('chatbot') ? api('/rules') : off(), api('/settings'), mod('chatbot') ? api('/kb') : off(), mod('flows') ? api('/flows') : off()]);
  const admin = can('bot.manage');
  appendTo(page, h('h2', {}, 'Chatbot & flows'), siteBar(),
    h('div', { class: 'card' }, h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: settings.botEnabled, disabled: !admin, onchange: guard(async e => { await api('/settings', 'PUT', { botEnabled: e.target.checked }); toast('Saved'); }) }), 'Enable chatbot for new conversations'),
      h('div', { class: 'hint' }, 'The bot answers with the first rule that matches, and hands over to a human on request. As soon as an agent replies, the bot stops.'),
      mod('chatbot') && h('label', {}, 'Try it'), mod('chatbot') && h('div', { class: 'row' }, h('input', { id: 'bt', placeholder: 'Type a visitor message to test the rules…', class: 'grow' }),
        h('button', { class: 'btn sec', onclick: guard(async () => { const { rule } = await api('/bot/test', 'POST', { text: document.getElementById('bt').value }); document.getElementById('btr').textContent = rule ? `✓ "${rule.name}" → ${rule.reply}` : '✗ No rule matches — fallback message is sent'; }) }, 'Test')), h('div', { class: 'hint', id: 'btr' })),
    mod('flows') && h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow', style: 'margin:0' }, 'Flows'), admin ? h('button', { class: 'btn', onclick: () => flowEditor(null) }, '+ New flow') : null),
      h('div', { class: 'hint' }, 'Guided conversations: the bot asks questions, offers choices, captures name/email and can hand over to a human. A flow starts when its keywords match and takes priority over simple rules.'),
      ...flows.map(f => h('div', { class: 'row', style: 'padding:10px 0;border-top:1px solid var(--bd)' }, h('div', { class: 'grow' }, h('b', {}, f.name), ' ', f.enabled ? null : h('span', { class: 'pill' }, 'disabled'),
        h('div', { class: 'hint' }, `Keywords: ${f.keywords} · ${f.nodes.length} steps`)),
        admin ? [h('button', { class: 'btn sec sm', onclick: () => flowEditor(f) }, 'Edit'), h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm('Delete flow?')) { await api('/flows/' + f.id, 'DELETE'); renderShell(); } }) }, 'Delete')] : null))),
    mod('ai') && h('div', { class: 'card' }, h('h3', {}, 'AI answers'),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: settings.aiEnabled, disabled: !admin, onchange: guard(async e => { await api('/settings', 'PUT', { aiEnabled: e.target.checked }); toast('Saved'); }) }), 'Use Claude to answer from the knowledge base when no rule matches'),
      h('div', { class: 'hint' }, S.aiConfigured ? '✓ ANTHROPIC_API_KEY is configured on the server.' : 'Set the ANTHROPIC_API_KEY environment variable on the server to enable this. Without it, the knowledge base still answers by keyword matching.'),
      h('label', {}, 'Assistant instructions'), h('textarea', { rows: 2, id: 'aiins', disabled: !admin }, settings.aiInstructions),
      admin ? h('button', { class: 'btn sec sm', style: 'margin-top:6px', onclick: guard(async () => { await api('/settings', 'PUT', { aiInstructions: document.getElementById('aiins').value }); toast('Saved'); }) }, 'Save instructions') : null),
    mod('chatbot') && h('div', { class: 'card' }, h('h3', {}, 'Knowledge base'), h('div', { class: 'hint' }, 'Question & answer pairs the bot uses when no rule matches (and that the AI answers from).'),
      ...kb.map(e => h('div', { class: 'row', style: 'padding:8px 0;border-bottom:1px solid var(--bd)' }, h('div', { class: 'grow' }, h('b', {}, e.question), h('div', {}, e.answer)),
        admin ? h('button', { class: 'btn danger sm', onclick: guard(async () => { await api('/kb/' + e.id, 'DELETE'); renderShell(); }) }, 'Delete') : null)),
      admin ? h('div', { style: 'margin-top:12px' }, h('input', { id: 'kbq', placeholder: 'Question, e.g. Do you ship internationally?' }), h('textarea', { id: 'kba', rows: 2, placeholder: 'Answer', style: 'margin-top:6px' }),
        h('button', { class: 'btn sm', style: 'margin-top:6px', onclick: guard(async () => { await api('/kb', 'POST', { question: document.getElementById('kbq').value, answer: document.getElementById('kba').value }); renderShell(); }) }, 'Add entry')) : null),
    mod('chatbot') && h('div', { class: 'row', style: 'margin-bottom:10px' }, h('h3', { class: 'grow', style: 'margin:0' }, 'Rules'), admin ? h('button', { class: 'btn', onclick: () => ruleEditor(main, null) }, '+ New rule') : null),
    ...rules.map(r => h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, r.name), ' ', r.handoff ? h('span', { class: 'pill warn' }, 'hands off to human') : null, r.enabled ? null : h('span', { class: 'pill' }, 'disabled'),
      h('div', { class: 'hint' }, 'Keywords: ' + r.keywords), h('div', {}, '💬 ' + r.reply), r.buttons.length ? h('div', { class: 'hint' }, 'Buttons: ' + r.buttons.join(' · ')) : null),
      admin ? [h('button', { class: 'btn sec sm', onclick: () => ruleEditor(main, r) }, 'Edit'), h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm('Delete rule?')) { await api('/rules/' + r.id, 'DELETE'); renderShell(); } }) }, 'Delete')] : null))));
}
export function flowEditor(f) {
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
export function ruleEditor(main, r) {
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

