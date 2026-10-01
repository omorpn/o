// AI knowledge: sources (website, sitemap, files, text), missed questions, playground and performance.
import { S, ago, api, appendTo, guard, h, icon, toast } from './core.js';
import { siteBar } from './dashboard.js';
import { renderShell } from './shell.js';

let tab = 'sources', poll = null;
const since = t => { const a = ago(t); return a === 'now' ? 'just now' : a + ' ago'; };
const STATUS = { ready: ['Ready', 'ok'], indexing: ['Indexing…', 'warn'], pending: ['Queued', 'warn'], error: ['Error', 'bad'] };
const TYPE = { url: '🌐 Website', sitemap: '🗺 Sitemap', pdf: '📄 PDF', csv: '📊 CSV', file: '📝 Document', text: '✍️ Text' };
const MODE = { ai: ['🤖 Claude', 'ok'], extractive: ['📖 Quoted from source', 'ok'], kb: ['💬 Q&A entry', 'ok'], rule: ['⚡ Rule', ''], flow: ['🔀 Flow', ''], none: ['✗ Not answered', 'bad'], unanswered: ['✗ Not answered', 'bad'] };
const pill = ([t, c]) => h('span', { class: 'pill ' + c }, t);

export async function renderKnowledge(main) {
  clearInterval(poll);
  const page = h('div', { class: 'page' }); main.append(page);
  const tabs = [['sources', 'Sources'], ['missed', 'Missed questions'], ['playground', 'Playground'], ['stats', 'Performance']];
  appendTo(page, h('h2', {}, 'AI knowledge'), siteBar(),
    h('p', { class: 'hint', style: 'margin-top:-8px' }, 'Teach the bot from your website and documents. ', S.aiConfigured ? 'Claude answers from the most relevant passages and cites them (turn on AI answers under Chatbot & flows).' : 'Without an AI key the bot quotes the best matching passage with a link to its source; set ANTHROPIC_API_KEY for written answers.'),
    h('div', { class: 'tabs' }, ...tabs.map(([k, l]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; renderShell(); } }, l))));
  await ({ sources, missed, playground, stats })[tab](page);
}

async function sources(page) {
  const d = await api('/knowledge/sources');
  const kind = h('select', { style: 'width:auto' }, h('option', { value: 'url' }, 'Website (crawl links)'), h('option', { value: 'sitemap' }, 'Sitemap URL'), h('option', { value: 'file' }, 'Upload file'), h('option', { value: 'text' }, 'Paste text'));
  const form = h('div');
  const draw = () => {
    const k = kind.value;
    if (k === 'url' || k === 'sitemap') {
      const url = h('input', { placeholder: k === 'url' ? 'https://yourshop.com' : 'https://yourshop.com/sitemap.xml', style: 'flex:1' }), max = h('input', { type: 'number', min: 1, max: d.limits.maxPages, value: 30, style: 'width:90px', title: 'Max pages' });
      form.replaceChildren(h('div', { class: 'row' }, url, k === 'url' ? [h('span', { class: 'hint', style: 'margin:0' }, 'max pages'), max] : null,
        h('button', { class: 'btn', onclick: guard(async () => { await api('/knowledge/sources', 'POST', { type: k, url: url.value, max_pages: +max.value }); toast('Crawling started'); renderShell(); }) }, 'Add')),
        h('div', { class: 'hint' }, k === 'url' ? 'Follows links on the same website and respects robots.txt. Re-crawled weekly, or press Sync after you change your site.' : 'Every page listed in the sitemap is read.'));
    } else if (k === 'file') {
      const inp = h('input', { type: 'file', accept: '.pdf,.csv,.txt,.md' });
      form.replaceChildren(h('div', { class: 'row' }, inp, h('button', { class: 'btn', onclick: guard(async () => {
        const f = inp.files[0]; if (!f) throw new Error('Choose a file'); if (f.size > 10e6) throw new Error('File too large (max 10 MB)');
        const data = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(f); });
        const r = await api('/knowledge/sources', 'POST', { type: 'file', name: f.name, data }); toast(r.source.status === 'ready' ? `Indexed ${r.source.chunks} passage(s)` : r.source.error); renderShell();
      }) }, 'Upload')), h('div', { class: 'hint' }, 'PDF (text, not scanned images), CSV (a question,answer table becomes FAQ entries; other tables one record per row, e.g. a product catalogue), TXT or Markdown.'));
    } else {
      const name = h('input', { placeholder: 'Title, e.g. Opening hours' }), text = h('textarea', { rows: 5, placeholder: 'Paste policies, product details, FAQs…' });
      form.replaceChildren(name, text, h('button', { class: 'btn', style: 'margin-top:8px', onclick: guard(async () => { await api('/knowledge/sources', 'POST', { type: 'text', name: name.value, text: text.value }); toast('Added'); renderShell(); }) }, 'Add text'));
    }
  };
  kind.onchange = draw; draw();
  const total = d.sources.reduce((n, s) => n + s.chunks, 0);
  appendTo(page, h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Add knowledge'), kind), form),
    h('div', { class: 'card' }, h('h3', {}, `Sources · ${total} passages`),
      d.sources.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Source'), h('th', {}, 'Status'), h('th', {}, 'Content'), h('th', {}, 'Updated'), h('th', {}))),
        h('tbody', {}, ...d.sources.map(s => h('tr', {},
          h('td', {}, h('div', {}, TYPE[s.type] || s.type), h('b', {}, s.name), s.url ? h('div', { class: 'hint', style: 'margin:0' }, h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.url)) : null),
          h('td', {}, pill(STATUS[s.status] || [s.status, '']), s.error ? h('div', { class: 'hint', style: 'margin:2px 0 0;max-width:260px' }, s.error) : null),
          h('td', {}, `${s.type === 'url' || s.type === 'sitemap' ? s.pages + ' page(s) · ' : ''}${s.chunks} passage(s)`),
          h('td', { class: 'hint' }, s.last_synced ? since(s.last_synced) : '—'),
          h('td', { style: 'white-space:nowrap' }, h('button', { class: 'btn sec sm', onclick: () => preview(s) }, 'View'), ' ',
            s.type === 'url' || s.type === 'sitemap' ? h('button', { class: 'btn sec sm', disabled: s.status === 'indexing', onclick: guard(async () => { await api(`/knowledge/sources/${s.id}/sync`, 'POST'); toast('Syncing'); renderShell(); }) }, 'Sync') : null, ' ',
            h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm(`Remove ${s.name}?`)) { await api('/knowledge/sources/' + s.id, 'DELETE'); renderShell(); } }) }, 'Remove'))))))
        : h('div', { class: 'empty' }, h('div', { class: 'big' }, '📚'), 'No sources yet — start with your website address')));
  if (d.sources.some(s => ['indexing', 'pending'].includes(s.status))) poll = setInterval(() => { if (S.view === 'knowledge' && tab === 'sources') renderShell(); else clearInterval(poll); }, 2500);
}
async function preview(s) {
  const d = await api(`/knowledge/sources/${s.id}/chunks`);
  const md = h('div', { class: 'modal', onclick: e => { if (e.target === md) md.remove(); } }, h('div', { class: 'card', style: 'width:720px;max-width:96vw;max-height:88vh;overflow:auto' },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, s.name), h('button', { class: 'btn sec sm', onclick: () => md.remove() }, 'Close')),
    h('p', { class: 'hint' }, `What the bot learned (first ${d.chunks.length} passages).`),
    ...d.chunks.map(c => h('div', { class: 'kchunk' }, h('b', {}, c.title || ''), c.url ? h('div', { class: 'hint', style: 'margin:0' }, c.url) : null, h('div', {}, c.content + (c.size > 400 ? '…' : ''))))));
  document.body.append(md);
}

async function missed(page) {
  const d = await api('/knowledge/missed');
  appendTo(page, h('div', { class: 'card' }, h('h3', {}, `Questions the bot couldn't answer · ${d.open} open`),
    h('p', { class: 'hint' }, 'Answer once and the bot knows it from then on (it is saved to the Q&A knowledge base). Similar questions are grouped.'),
    ...(d.questions.length ? d.questions.map(q => {
      const ans = h('textarea', { rows: 2, placeholder: 'Write the answer the bot should give…' });
      return h('div', { class: 'missed' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, q.question), q.count > 1 ? h('span', { class: 'pill warn' }, `asked ${q.count}×`) : null, h('span', { class: 'hint', style: 'margin:0' }, since(q.last_asked))),
        ans, h('div', { class: 'row', style: 'margin-top:6px;justify-content:flex-end' },
          q.conv_id ? h('a', { href: '#', class: 'hint', style: 'margin:0 auto 0 0', onclick: e => { e.preventDefault(); S.view = 'inbox'; S.filter = 'open'; S.cur = q.conv_id; renderShell(); } }, 'Open the chat') : null,
          h('button', { class: 'btn sec sm', onclick: guard(async () => { await api(`/knowledge/missed/${q.id}/ignore`, 'POST'); renderShell(); }) }, 'Ignore'),
          h('button', { class: 'btn sm', onclick: guard(async () => { await api(`/knowledge/missed/${q.id}/answer`, 'POST', { answer: ans.value }); toast('Saved — the bot will answer this now'); renderShell(); }) }, 'Save answer')));
    }) : [h('div', { class: 'empty' }, h('div', { class: 'big' }, '🎉'), 'Nothing missed')])));
}

async function playground(page) {
  const q = h('input', { placeholder: 'Ask what a customer would ask, e.g. How long does delivery take?', style: 'flex:1' }), out = h('div');
  const ask = guard(async () => {
    if (!q.value.trim()) return;
    out.replaceChildren(h('div', { class: 'hint' }, 'Thinking…'));
    const r = await api('/knowledge/playground', 'POST', { question: q.value });
    out.replaceChildren(
      h('div', { class: 'row', style: 'margin:12px 0 6px' }, pill(MODE[r.mode] || [r.mode, '']), r.matched.rule ? h('span', { class: 'hint', style: 'margin:0' }, `rule “${r.matched.rule}”`) : null, r.matched.flow ? h('span', { class: 'hint', style: 'margin:0' }, `flow “${r.matched.flow}”`) : null,
        r.matched.kb ? h('span', { class: 'hint', style: 'margin:0' }, `Q&A “${r.matched.kb}”`) : null, r.ai.configured && !r.ai.enabled ? h('span', { class: 'hint', style: 'margin:0' }, '(AI answers are off for live chats)') : null),
      h('div', { class: 'pv-b', style: 'white-space:pre-wrap;max-width:none' }, r.answer),
      r.sources.length ? h('div', { class: 'hint' }, 'Sources: ', ...r.sources.map(s => s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener', style: 'margin-right:8px' }, s.title || s.url) : h('span', {}, s.title))) : null,
      h('h4', { class: 'dh' }, 'Most relevant passages'),
      ...(r.passages.length ? r.passages.map(p => h('div', { class: 'kchunk' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, p.title || ''), h('span', { class: 'pill' }, `${p.coverage}% match`)), p.url ? h('div', { class: 'hint', style: 'margin:0' }, p.url) : null, h('div', {}, p.content)))
        : [h('div', { class: 'hint' }, 'No passage mentions these words — add a source that covers it, or answer it under Missed questions.')]));
  });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') ask(); });
  appendTo(page, h('div', { class: 'card' }, h('h3', {}, 'Playground'), h('p', { class: 'hint' }, 'See exactly what the bot would reply, which step answers (flow, rule, Q&A, knowledge or AI) and which passages it relies on. Nothing is sent to visitors.'),
    h('div', { class: 'row' }, q, h('button', { class: 'btn', onclick: ask }, 'Ask')), out));
  q.focus();
}

async function stats(page) {
  const d = await api('/knowledge/stats?days=30');
  const tile = (ic, n, l, cls = '') => h('div', { class: 'stat ' + cls }, h('div', { class: 'ico' }, icon(ic)), h('div', {}, h('b', {}, n ?? '—'), h('span', {}, l)));
  appendTo(page, h('div', { class: 'grid' }, tile('check', d.answered, 'questions answered (30 days)', 'ok'), tile('bot', d.answerRate == null ? null : d.answerRate + '%', 'answer rate'),
      tile('users', d.resolvedWithoutHuman == null ? null : d.resolvedWithoutHuman + '%', 'chats resolved without a human'), tile('alert', d.unanswered, 'not answered', 'warn')),
    h('div', { class: 'grid2', style: 'align-items:start' },
      h('div', { class: 'card' }, h('h3', {}, 'Most used sources'), ...(d.topSources.length ? d.topSources.map(s => h('div', { class: 'row', style: 'padding:5px 0' }, h('span', { class: 'grow', style: 'word-break:break-all' }, s.source), h('b', {}, s.uses))) : [h('div', { class: 'hint' }, 'No answers yet')])),
      h('div', { class: 'card' }, h('h3', {}, 'Recent questions'), ...d.recent.map(r => h('div', { class: 'missed' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, r.question), pill(MODE[r.mode] || [r.mode, ''])), r.answer ? h('div', { class: 'hint', style: 'margin:2px 0 0' }, r.answer.slice(0, 160)) : null)))));
}
