// Social channels: connect (credential probe), webhook verification + signatures, WhatsApp/Messenger/Instagram inbound,
// bot replies with buttons, agent replies, media in, delivery receipts, 24-hour window, templates, dedupe, encryption.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
process.env.DB_FILE = ':memory:';
process.env.SLA_CHECK_MS = '3600000';
process.env.DATA_KEY = 'test-data-key-123';

// ---------- fake Graph API ----------
const sent = [];
const graph = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const u = new URL(req.url, 'http://x'), json = (d, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (req.headers.authorization !== 'Bearer GOOD_TOKEN') return json({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 401);
  if (u.pathname === '/v21.0/1111111111' && req.method === 'GET') return json({ display_phone_number: '+234 801 000 0000', verified_name: 'Kola Shop' });
  if (u.pathname === '/v21.0/2222222222' && req.method === 'GET') return json({ name: 'Kola Shop Page' });
  if (u.pathname === '/v21.0/987654' && req.method === 'GET') return json({ name: 'Funmi Ade' }); // Messenger profile
  if (u.pathname === '/v21.0/MEDIA1') return json({ url: '/media-bin/MEDIA1' });
  if (u.pathname === '/media-bin/MEDIA1') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from('PNGBYTES')); }
  if (u.pathname.endsWith('/messages') && req.method === 'POST') { const d = JSON.parse(b); sent.push({ path: u.pathname, body: d }); if (d.text?.body === 'FAIL') return json({ error: { message: 'Recipient phone number not in allowed list' } }, 400); return json(d.messaging_product ? { messages: [{ id: 'wamid.OUT' + sent.length }] } : { message_id: 'm_OUT' + sent.length }); }
  json({ error: { message: 'not found' } }, 404);
});
await new Promise(r => graph.listen(0, r));
process.env.GRAPH_BASE_URL = `http://127.0.0.1:${graph.address().port}`;

const { server } = await import('../server/index.js');
const { db } = await import('../server/core/db.js');
await new Promise(r => server.listen(0, r));
const B = `http://localhost:${server.address().port}`;
const j = async (p, method = 'GET', body, cookie, headers = {}) => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...headers, ...(cookie && { cookie }) }, body: typeof body === 'string' ? body : body && JSON.stringify(body) });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const owner = (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'admin123' }) })).headers.get('set-cookie').split(';')[0];
const SITE = (await j('/api/me', 'GET', null, owner)).body.sites[0].id;
db.prepare("DELETE FROM rules WHERE site_id=? AND name NOT IN ('Pricing')").run(SITE);

// ---------- connect ----------
assert.equal((await j('/api/channels', 'POST', { type: 'whatsapp', account_id: '1111111111', token: 'BAD', app_secret: 'appsecret' }, owner)).status, 400, 'bad token rejected by Meta');
assert.equal((await j('/api/channels', 'POST', { type: 'whatsapp', account_id: 'abc', token: 'GOOD_TOKEN', app_secret: 'x' }, owner)).status, 400);
const wa = (await j('/api/channels', 'POST', { type: 'whatsapp', account_id: '1111111111', token: 'GOOD_TOKEN', app_secret: 'appsecret', site_id: SITE }, owner)).body.channel;
assert.equal(wa.display, '+234 801 000 0000 · Kola Shop'); assert.equal(wa.token, 'GOOD…OKEN', 'token masked'); assert.match(wa.webhook_url, /\/api\/channels\/webhook\/[a-f0-9]{36}$/);
assert.match(db.prepare('SELECT token FROM channels WHERE id=?').get(wa.id).token, /^v1:/, 'encrypted at rest with DATA_KEY');
assert.equal((await j('/api/channels', 'POST', { type: 'whatsapp', account_id: '1111111111', token: 'GOOD_TOKEN', app_secret: 'x' }, owner)).status, 409);
const fb = (await j('/api/channels', 'POST', { type: 'messenger', account_id: '2222222222', token: 'GOOD_TOKEN', app_secret: 'fbsecret' }, owner)).body.channel;
const ig = (await j('/api/channels', 'POST', { type: 'instagram', account_id: '3333333333', page_id: '2222222222', token: 'GOOD_TOKEN', app_secret: 'igsecret' }, owner));
assert.equal(ig.status, 400, 'instagram account probe fails (unknown id in fake)');
const WH = wa.webhook_url.replace(/^https?:\/\/[^/]+/, B), FBH = fb.webhook_url.replace(/^https?:\/\/[^/]+/, B);

// ---------- webhook verification ----------
let r = await j(`${WH.replace(B, '')}?hub.mode=subscribe&hub.verify_token=${wa.verify_token}&hub.challenge=12345`);
assert.equal(r.status, 200); assert.equal(r.text, '12345');
assert.equal((await j(`${WH.replace(B, '')}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);
const post = (url, body, secret) => { const raw = JSON.stringify(body); return j(url.replace(B, ''), 'POST', raw, null, { 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex') }); };
const waMsg = (id, text, extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1111111111' },
  contacts: [{ profile: { name: 'Tunde' }, wa_id: '2348012345678' }], messages: [{ from: '2348012345678', id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...extra }] } }] }] });
assert.equal((await post(WH, waMsg('wamid.1', 'hi'), 'wrong-secret')).status, 401, 'bad signature rejected');

// ---------- WhatsApp inbound → bot reply with buttons ----------
assert.equal((await post(WH, waMsg('wamid.1', 'what are your prices?'), 'appsecret')).status, 200);
await post(WH, waMsg('wamid.1', 'what are your prices?'), 'appsecret'); // Meta retry
await sleep(1200);
const vkey = `${SITE}:wa_2348012345678`, conv = () => db.prepare('SELECT * FROM conversations WHERE visitor_id=?').get(vkey);
const msgs = () => db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id').all(conv().id);
assert.equal(conv().channel, 'whatsapp'); assert.equal(db.prepare('SELECT name, phone, channel FROM visitors WHERE id=?').get(vkey).name, 'Tunde');
assert.equal(msgs().filter(m => m.sender === 'visitor').length, 1, 'duplicate delivery ignored');
const botOut = sent.find(s => s.body.to === '2348012345678');
assert.ok(botOut, 'bot reply sent to WhatsApp'); assert.match(JSON.stringify(botOut.body), /\$19/);
assert.equal(msgs().find(m => m.sender === 'bot').delivery, 'sent');

// interactive button reply + talk to a human
const fallbackBtns = sent.length;
await post(WH, waMsg('wamid.2', 'blah blah unknown'), 'appsecret'); await sleep(1200);
const fallback = sent.slice(fallbackBtns).find(s => s.body.type === 'interactive');
assert.ok(fallback, 'fallback offers a button'); assert.equal(fallback.body.interactive.action.buttons[0].reply.title, 'Talk to a human');
await post(WH, waMsg('wamid.3', '', { type: 'interactive', text: undefined, interactive: { type: 'button_reply', button_reply: { id: 'b0', title: 'Talk to a human' } } }), 'appsecret'); await sleep(1200);
assert.equal(conv().needs_human, 1, 'button tap hands off');

// ---------- agent reply, delivery receipts ----------
await j(`/api/conversations/${conv().id}/messages`, 'POST', { body: 'Hi Tunde, Ada here — how can I help?' }, owner); await sleep(200);
const out = sent.at(-1); assert.equal(out.body.text.body, 'Hi Tunde, Ada here — how can I help?'); assert.equal(out.path, '/v21.0/1111111111/messages');
const agentMsg = msgs().filter(m => m.sender === 'agent').at(-1); assert.equal(agentMsg.delivery, 'sent'); assert.match(agentMsg.external_id, /^wamid\.OUT/);
await post(WH, { entry: [{ changes: [{ value: { metadata: { phone_number_id: '1111111111' }, statuses: [{ id: agentMsg.external_id, status: 'read' }] } }] }] }, 'appsecret');
assert.equal(db.prepare('SELECT delivery FROM messages WHERE id=?').get(agentMsg.id).delivery, 'read');
// send failure becomes a note
await j(`/api/conversations/${conv().id}/messages`, 'POST', { body: 'FAIL' }, owner); await sleep(200);
assert.ok(msgs().some(m => m.sender === 'note' && /Not delivered to WhatsApp: Recipient phone number not in allowed list/.test(m.body)));
// agent replies are not emailed for social chats
assert.equal(db.prepare('SELECT email FROM visitors WHERE id=?').get(vkey).email, null);

// ---------- inbound media ----------
await post(WH, waMsg('wamid.4', '', { type: 'image', text: undefined, image: { id: 'MEDIA1', mime_type: 'image/png', caption: 'my receipt' } }), 'appsecret'); await sleep(200);
const img = msgs().filter(m => m.sender === 'visitor').at(-1);
assert.equal(img.body, 'my receipt'); assert.equal(JSON.parse(img.attachment).type, 'image/png');

// ---------- 24-hour window & templates ----------
db.prepare('UPDATE conversations SET last_inbound=? WHERE id=?').run(Date.now() - 25 * 3600_000, conv().id);
const before = sent.length;
await j(`/api/conversations/${conv().id}/messages`, 'POST', { body: 'Are you still there?' }, owner); await sleep(200);
assert.equal(sent.length, before, 'nothing sent outside the window'); assert.ok(msgs().some(m => /24 hours/.test(m.body)));
assert.equal((await j(`/api/conversations/${conv().id}/template`, 'POST', { name: 'Bad Name!' }, owner)).status, 400);
const tpl = (await j(`/api/conversations/${conv().id}/template`, 'POST', { name: 'order_update', language: 'en', params: ['#1001', 'Tuesday'] }, owner)).body;
assert.equal(tpl.message.delivery, 'sent'); await sleep(100);
const tsent = sent.at(-1).body; assert.equal(tsent.type, 'template'); assert.equal(tsent.template.name, 'order_update'); assert.equal(tsent.template.components[0].parameters[1].text, 'Tuesday');
assert.equal(sent.length, before + 1, 'template not sent twice');

// ---------- Messenger ----------
const fbEv = (mid, text) => ({ object: 'page', entry: [{ id: '2222222222', time: Date.now(), messaging: [{ sender: { id: '987654' }, recipient: { id: '2222222222' }, timestamp: Date.now(), message: { mid, text } }] }] });
assert.equal((await post(FBH, fbEv('m_1', 'hello from messenger'), 'appsecret')).status, 401, "another channel's secret doesn't work");
await post(FBH, fbEv('m_1', 'Do you deliver on Sunday?'), 'fbsecret'); await sleep(1200);
const fconv = db.prepare('SELECT * FROM conversations WHERE visitor_id=?').get(`${SITE}:fb_987654`);
assert.equal(fconv.channel, 'messenger'); assert.equal(db.prepare('SELECT name FROM visitors WHERE id=?').get(`${SITE}:fb_987654`).name, 'Funmi Ade', 'profile name fetched');
await j(`/api/conversations/${fconv.id}/messages`, 'POST', { body: 'Yes, we deliver on Sundays in Lagos.' }, owner); await sleep(200);
const fout = sent.at(-1); assert.equal(fout.path, '/v21.0/2222222222/messages'); assert.equal(fout.body.recipient.id, '987654'); assert.equal(fout.body.message.text, 'Yes, we deliver on Sundays in Lagos.');
const ec = sent.length; await post(FBH, { object: 'page', entry: [{ id: '2222222222', messaging: [{ sender: { id: '2222222222' }, recipient: { id: '987654' }, message: { mid: 'm_echo', text: 'echo', is_echo: true } }] }] }, 'fbsecret');
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE body='echo'").get().n, 0, 'echoes of our own messages ignored');

// ---------- inbox shows the channel ----------
const list = (await j('/api/conversations?status=open', 'GET', null, owner)).body.conversations;
assert.ok(list.some(c => c.channel === 'whatsapp' && c.visitor.phone === '+2348012345678')); assert.ok(list.some(c => c.channel === 'messenger'));

// ---------- disable / module off / delete ----------
await j(`/api/channels/${wa.id}`, 'PUT', { enabled: false }, owner);
await post(WH, waMsg('wamid.9', 'ignored?'), 'appsecret'); assert.ok(!db.prepare("SELECT 1 FROM messages WHERE body='ignored?'").get(), 'disabled channel ignores messages');
await j(`/api/channels/${wa.id}`, 'PUT', { enabled: true }, owner);
assert.equal((await j(`/api/channels/${wa.id}/test`, 'POST', null, owner)).body.ok, true);
await j('/api/modules/channels', 'PUT', { enabled: false }, owner);
assert.equal((await j('/api/channels', 'GET', null, owner)).status, 403);
await post(WH, waMsg('wamid.10', 'module off'), 'appsecret'); assert.ok(!db.prepare("SELECT 1 FROM messages WHERE body='module off'").get());
await j('/api/modules/channels', 'PUT', { enabled: true }, owner);
assert.equal((await j(`/api/channels/${fb.id}`, 'DELETE', null, owner)).status, 200);
assert.equal((await post(FBH, fbEv('m_2', 'gone'), 'fbsecret')).status, 404);

graph.close();
console.log('all channel tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
