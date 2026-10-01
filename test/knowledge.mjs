// AI knowledge: crawler (robots, same-site, sitemap), SSRF guard, PDF/CSV/text sources, FTS retrieval, extractive answers,
// Claude answers grounded in passages with citations (fake API), missed questions, playground, stats.
import assert from 'node:assert/strict';
import http from 'node:http';
import { deflateSync } from 'node:zlib';
process.env.DB_FILE = ':memory:';
process.env.SLA_CHECK_MS = '3600000';
process.env.ALLOW_PRIVATE_CRAWL = '1';
const { server } = await import('../server/index.js');
const { db } = await import('../server/core/db.js');
const { pdfText, csvChunks, htmlToDoc, chunkText, robotsRules } = await import('../server/modules/knowledge/extract.js');
await new Promise(r => server.listen(0, r));
const B = `http://localhost:${server.address().port}`;
const j = async (p, method = 'GET', body, cookie) => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(100); } throw new Error('timeout'); };

// ---------- a small shop website ----------
const page = (title, body, links = '') => `<!doctype html><html><head><title>${title}</title></head><body><nav><a href="/">Home</a> menu junk</nav><main><h1>${title}</h1>${body}${links}</main><footer>© footer text</footer><script>var x="no"</script></body></html>`;
const SITE = {
  '/': page('Kola Shop', '<p>Welcome to Kola Shop, handmade leather goods from Lagos.</p>', '<a href="/shipping">Shipping</a> <a href="/returns#top">Returns</a> <a href="/private/admin">Admin</a> <a href="https://elsewhere.example/x">Other</a> <a href="/logo.png">logo</a>'),
  '/shipping': page('Shipping information', '<p>We deliver within Lagos in 1&ndash;2 business days.</p><p>Delivery to Abuja and Port Harcourt takes 3 to 5 business days and costs &#8358;3,500.</p><p>International shipping is not available yet.</p>'),
  '/returns': page('Returns policy', '<p>You can return any unused item within 14 days of delivery for a full refund.</p><p>Email returns@kola.ng with your order number to start a return.</p>'),
  '/private/admin': page('Secret admin', '<p>Internal staff password list</p>'),
  '/robots.txt': 'User-agent: *\nDisallow: /private\n',
  '/sitemap.xml': '<?xml version="1.0"?><urlset><url><loc>BASE/shipping</loc></url><url><loc>BASE/returns</loc></url></urlset>',
};
const shop = http.createServer((req, res) => {
  const p = req.url.split('?')[0], body = SITE[p];
  if (p === '/moved') { res.writeHead(301, { Location: '/shipping' }); return res.end(); }
  if (!body) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': p.endsWith('.txt') ? 'text/plain' : p.endsWith('.xml') ? 'application/xml' : 'text/html; charset=utf-8' });
  res.end(body.replace(/BASE/g, `http://127.0.0.1:${shop.address().port}`));
});
await new Promise(r => shop.listen(0, r));
const SHOP = `http://127.0.0.1:${shop.address().port}`;

// ---------- fake Claude API ----------
const aiCalls = [];
const fakeAi = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c; const body = JSON.parse(b); aiCalls.push(body);
  const q = body.messages.at(-1).content.toLowerCase();
  const n = body.system.split(/\n(?=\[\d+\] )/).find(d => d.includes('14 days'))?.match(/^\[(\d+)\]/)?.[1]; // cite the document that holds the answer
  const text = /refund|return/.test(q) && n ? `You can return unused items within 14 days for a full refund — just email returns@kola.ng.\nSOURCES: ${n}` : 'HANDOFF';
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
});
await new Promise(r => fakeAi.listen(0, r));

// ---------- extraction units ----------
const doc = htmlToDoc(SITE['/shipping'], SHOP + '/shipping');
assert.equal(doc.title, 'Shipping information'); assert.match(doc.text, /1–2 business days/); assert.match(doc.text, /₦3,500/);
assert.doesNotMatch(doc.text, /menu junk|footer text|var x/, 'nav, footer and scripts removed');
assert.ok(htmlToDoc(SITE['/'], SHOP + '/').links.includes(SHOP + '/returns'), 'links resolved, hash dropped');
assert.ok(!htmlToDoc(SITE['/'], SHOP + '/').links.some(l => l.endsWith('.png')));
assert.deepEqual(robotsRules('User-agent: Googlebot\nDisallow: /g\nUser-agent: *\nDisallow: /private\nDisallow:'), ['/private']);
assert.ok(chunkText('A'.repeat(50) + '. ' + 'Sentence two is here. '.repeat(100), 500).every(c => c.length <= 560));
const faq = csvChunks('question,answer\n"Do you sell gift cards?","Yes, from ₦5,000"\nOpen on Sunday?,No\n', 'faq.csv');
assert.equal(faq.length, 2); assert.equal(faq[0].content, 'Q: Do you sell gift cards?\nA: Yes, from ₦5,000');
const cat = csvChunks('sku;name;price\nB1;Leather bag;25000\nW2;Wallet;8000', 'catalog.csv');
assert.equal(cat[1].content, 'sku: W2\nname: Wallet\nprice: 8000');
// a PDF with a compressed content stream, TJ arrays, escapes, and a ToUnicode-mapped hex string
const content = 'BT /F1 12 Tf 72 720 Td (Warranty: all bags carry a 2 year warranty) Tj 0 -14 Td [(Repairs are ) -250 (free \\(parts included\\)) ] TJ T* <00480049> Tj ET';
const cmapStream = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 2 beginbfchar <0048> <0048> <0049> <0069> endbfchar endcmap end end';
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Length 99 /Filter /FlateDecode >>\nstream\n', 'latin1'), deflateSync(Buffer.from(content, 'latin1')), Buffer.from('\nendstream\nendobj\n2 0 obj << /Length 9 >>\nstream\n' + cmapStream + '\nendstream\nendobj\n%%EOF', 'latin1')]);
const ptxt = pdfText(pdf);
assert.match(ptxt, /Warranty: all bags carry a 2 year warranty/); assert.match(ptxt, /Repairs are free \(parts included\)/); assert.match(ptxt, /\bHi\b/, 'ToUnicode mapping');

// ---------- setup ----------
const owner = (await j('/api/auth/login', 'POST', { email: 'admin@example.com', password: 'admin123' })).headers.get('set-cookie').split(';')[0];
const me = (await j('/api/me', 'GET', null, owner)).body, SID = me.sites[0].id, key = me.sites[0].site_key, Q = `?site=${SID}`;
// the demo seed has a shipping rule and return/payment Q&As that would answer first; keep only the Pricing rule
db.prepare("DELETE FROM rules WHERE site_id=? AND name!='Pricing'").run(SID); db.prepare('DELETE FROM kb WHERE site_id=?').run(SID); db.prepare('DELETE FROM flows WHERE site_id=?').run(SID);
await j('/api/roles', 'GET', null, owner);
const agentRole = (await j('/api/roles', 'GET', null, owner)).body.roles.find(r => r.name === 'Agent').id;
await j('/api/members', 'POST', { name: 'Ann', email: 'ann@co.com', password: 'password1', role_id: agentRole }, owner);
const ann = (await j('/api/auth/login', 'POST', { email: 'ann@co.com', password: 'password1' })).headers.get('set-cookie').split(';')[0];
assert.equal((await j('/api/knowledge/sources' + Q, 'GET', null, ann)).status, 403, 'agents cannot manage knowledge');

// ---------- SSRF guard ----------
process.env.ALLOW_PRIVATE_CRAWL = '0';
for (const u of ['http://127.0.0.1:1/x', 'http://localhost/x', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd'])
  assert.equal((await j('/api/knowledge/sources' + Q, 'POST', { type: 'url', url: u }, owner)).status, 400, u);
process.env.ALLOW_PRIVATE_CRAWL = '1';

// ---------- website crawl ----------
const added = (await j('/api/knowledge/sources' + Q, 'POST', { type: 'url', url: SHOP + '/', max_pages: 10 }, owner)).body.source;
const ready = await until(async () => { const s = (await j('/api/knowledge/sources' + Q, 'GET', null, owner)).body.sources.find(x => x.id === added.id); return s.status === 'ready' && s; });
assert.equal(ready.pages, 3, 'home, shipping, returns — robots.txt blocks /private, other hosts and images skipped');
const chunks = (await j(`/api/knowledge/sources/${added.id}/chunks${Q}`, 'GET', null, owner)).body.chunks;
assert.ok(!chunks.some(c => /password/.test(c.content))); assert.ok(chunks.some(c => c.url === SHOP + '/returns'));
// sitemap source
const sm = (await j('/api/knowledge/sources' + Q, 'POST', { type: 'sitemap', url: SHOP + '/sitemap.xml' }, owner)).body.source;
assert.equal((await until(async () => { const s = (await j('/api/knowledge/sources' + Q, 'GET', null, owner)).body.sources.find(x => x.id === sm.id); return s.status === 'ready' && s; })).pages, 2);
await j(`/api/knowledge/sources/${sm.id}${Q}`, 'DELETE', null, owner);
assert.equal(db.prepare('SELECT COUNT(*) n FROM knowledge_chunks WHERE source_id=?').get(sm.id).n, 0);
// broken site
const bad = (await j('/api/knowledge/sources' + Q, 'POST', { type: 'url', url: SHOP + '/missing' }, owner)).body.source;
const badS = await until(async () => { const s = (await j('/api/knowledge/sources' + Q, 'GET', null, owner)).body.sources.find(x => x.id === bad.id); return s.status === 'error' && s; });
assert.match(badS.error, /404/);

// ---------- files & text ----------
let r = await j('/api/knowledge/sources' + Q, 'POST', { type: 'file', name: 'warranty.pdf', data: pdf.toString('base64') }, owner);
assert.equal(r.body.source.status, 'ready'); assert.ok(r.body.source.chunks >= 1);
r = await j('/api/knowledge/sources' + Q, 'POST', { type: 'file', name: 'faq.csv', data: Buffer.from('question,answer\nDo you sell gift cards?,"Yes, gift cards from ₦5,000 are sold in store and online."\n').toString('base64') }, owner);
assert.equal(r.body.source.chunks, 1);
assert.equal((await j('/api/knowledge/sources' + Q, 'POST', { type: 'file', name: 'evil.exe', data: 'AAAA' }, owner)).status, 400);
assert.equal((await j('/api/knowledge/sources' + Q, 'POST', { type: 'text', name: 'Hours', text: 'Our Lekki showroom opens Monday to Saturday from 9am to 6pm. We are closed on Sundays and public holidays.' }, owner)).body.source.status, 'ready');
assert.equal((await j('/api/knowledge/sources' + Q, 'POST', { type: 'file', name: 'scan.pdf', data: Buffer.from('%PDF-1.4 no text').toString('base64') }, owner)).body.source.status, 'error');

// ---------- playground (no AI key → extractive) ----------
let pg = (await j('/api/knowledge/playground' + Q, 'POST', { question: 'How long does delivery to Abuja take?' }, owner)).body;
assert.equal(pg.mode, 'extractive'); assert.match(pg.answer, /3 to 5 business days/); assert.equal(pg.sources[0].url, SHOP + '/shipping'); assert.ok(pg.passages[0].coverage > 50);
pg = (await j('/api/knowledge/playground' + Q, 'POST', { question: 'Is there a warranty on bags?' }, owner)).body;
assert.match(pg.answer, /2 year warranty/);
pg = (await j('/api/knowledge/playground' + Q, 'POST', { question: 'Do you accept crypto payments?' }, owner)).body;
assert.equal(pg.mode, 'none', 'nothing relevant → fallback');
pg = (await j('/api/knowledge/playground' + Q, 'POST', { question: 'what are your prices' }, owner)).body;
assert.equal(pg.mode, 'rule', 'rules still take priority');

// ---------- live chat: extractive answers + missed questions ----------
const thread = async vid => db.prepare("SELECT m.sender, m.body FROM messages m JOIN conversations c ON c.id=m.conv_id WHERE c.visitor_id=? ORDER BY m.id").all(`${SID}:${vid}`);
await j('/api/widget/message', 'POST', { key, vid: 'visitorKNOW001', body: 'When is the showroom open on Saturday?' }); await sleep(1100);
let t = await thread('visitorKNOW001');
assert.match(t.at(-1).body, /Monday to Saturday from 9am to 6pm/); assert.equal(t.at(-1).sender, 'bot');
await j('/api/widget/message', 'POST', { key, vid: 'visitorKNOW002', body: 'Do you accept crypto payments?' }); await sleep(1100);
await j('/api/widget/message', 'POST', { key, vid: 'visitorKNOW003', body: 'do you accept CRYPTO payments' }); await sleep(1100);
let missed = (await j('/api/knowledge/missed' + Q, 'GET', null, owner)).body;
assert.equal(missed.open, 1); assert.equal(missed.questions[0].count, 2, 'same question grouped');
assert.equal((await j(`/api/knowledge/missed/${missed.questions[0].id}/answer${Q}`, 'POST', { answer: 'Not yet — we accept cards, bank transfer and Paystack.' }, owner)).status, 200);
assert.equal((await j('/api/knowledge/missed' + Q, 'GET', null, owner)).body.open, 0);
await j('/api/widget/message', 'POST', { key, vid: 'visitorKNOW004', body: 'Do you accept crypto payments?' }); await sleep(1100);
assert.match((await thread('visitorKNOW004')).at(-1).body, /Paystack/, 'answered next time from the knowledge base');

// ---------- Claude grounded answers with citations ----------
process.env.ANTHROPIC_API_KEY = 'test-key'; process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fakeAi.address().port}`;
await j(`/api/settings${Q}`, 'PUT', { aiEnabled: true }, owner);
await j('/api/widget/message', 'POST', { key, vid: 'visitorKNOW005', body: 'How do I get a refund for a bag I bought?' }); await sleep(1300);
t = await thread('visitorKNOW005');
assert.match(t.at(-1).body, /within 14 days[\s\S]*Source: .*\/returns/, 'AI answer cites the page it used');
assert.match(aiCalls.at(-1).system, /\[\d\] Returns policy/, 'relevant passage sent to the model');
await j('/api/widget/message', 'POST', { key, vid: 'visitorKNOW006', body: 'Can I pay with gold bars?' }); await sleep(1300);
t = await thread('visitorKNOW006');
assert.match(t.at(-1).body, /not sure/i, 'model unsure (HANDOFF) → fallback message');
assert.ok((await j('/api/knowledge/missed' + Q, 'GET', null, owner)).body.questions.some(q => /gold bars/.test(q.question)));
pg = (await j('/api/knowledge/playground' + Q, 'POST', { question: 'refund for a returned bag?' }, owner)).body;
assert.equal(pg.mode, 'ai'); assert.equal(pg.sources[0].url, SHOP + '/returns');
delete process.env.ANTHROPIC_API_KEY;

// ---------- stats ----------
const st = (await j('/api/knowledge/stats' + Q, 'GET', null, owner)).body;
assert.ok(st.extractive >= 1 && st.ai === 1 && st.unanswered >= 3); assert.ok(st.answerRate > 0 && st.answerRate < 100);
assert.ok(st.topSources.some(s => /returns/.test(s.source)));

// ---------- module off ----------
await j('/api/modules/knowledge', 'PUT', { enabled: false }, owner);
assert.equal((await j('/api/knowledge/sources' + Q, 'GET', null, owner)).status, 403);
await j('/api/widget/message', 'POST', { key, vid: 'visitorKNOW007', body: 'When is the showroom open on Saturday?' }); await sleep(1100);
assert.doesNotMatch((await thread('visitorKNOW007')).at(-1).body, /9am to 6pm/, 'no knowledge answers when the module is off');

shop.close(); fakeAi.close();
console.log('all knowledge tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
