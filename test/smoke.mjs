import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
const { server } = await import('../server/index.js');
await new Promise(r => server.listen(0, r));
const B = `http://localhost:${server.address().port}`;
const j = async (p, method = 'GET', body, cookie) => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// auth
assert.equal((await j('/api/conversations')).status, 401);
assert.equal((await j('/api/auth/login', 'POST', { email: 'admin@example.com', password: 'nope' })).status, 401);
const login = await j('/api/auth/login', 'POST', { email: 'admin@example.com', password: 'admin123' });
assert.equal(login.status, 200);
const ck = login.headers.get('set-cookie').split(';')[0];
const { key } = (await j('/api/site-key')).body;

// agent SSE listener
const events = [];
const ac = new AbortController();
fetch(B + '/api/events', { headers: { cookie: ck }, signal: ac.signal }).then(async r => {
  const dec = new TextDecoder(); let buf = '';
  for await (const c of r.body) { buf += dec.decode(c); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const m = f.match(/event: (\w+)\ndata: (.*)/); if (m) events.push([m[1], JSON.parse(m[2])]); } }
}).catch(() => {});
await sleep(200);

// widget
const vid = 'vtest1234567890';
assert.equal((await j('/api/widget/init', 'POST', { key: 'bad', vid })).status, 403);
const init = await j('/api/widget/init', 'POST', { key, vid, page: 'http://x/y' });
assert.equal(init.status, 200); assert.equal(init.body.agentsOnline, true);
await j('/api/widget/message', 'POST', { key, vid, body: 'hello there' });
await sleep(1000);
let convs = (await j('/api/conversations?status=open', 'GET', null, ck)).body.conversations;
assert.equal(convs.length, 1);
let msgs = (await j('/api/conversations/' + convs[0].id, 'GET', null, ck)).body.messages;
assert.deepEqual(msgs.map(m => m.sender), ['visitor', 'bot']);
assert.match(msgs[1].body, /Hello/);
assert.ok(events.some(e => e[0] === 'message'));

// fallback + handoff
await j('/api/widget/message', 'POST', { key, vid, body: 'zzzz qqq' }); await sleep(1000);
await j('/api/widget/message', 'POST', { key, vid, body: 'Talk to a human' }); await sleep(1000);
const c1 = (await j('/api/conversations/' + convs[0].id, 'GET', null, ck)).body;
assert.equal(c1.conversation.needs_human, true); assert.equal(c1.conversation.bot_active, false);

// bot silent after handoff; agent replies
await j('/api/widget/message', 'POST', { key, vid, body: 'pricing?' }); await sleep(1000);
const n = (await j('/api/conversations/' + convs[0].id, 'GET', null, ck)).body.messages.length;
const rep = await j(`/api/conversations/${convs[0].id}/messages`, 'POST', { body: 'Hi, agent here' }, ck);
assert.equal(rep.status, 200);
const after = (await j('/api/conversations/' + convs[0].id, 'GET', null, ck)).body;
assert.equal(after.messages.length, n + 1); assert.equal(after.conversation.assignee_name, 'Admin'); assert.equal(after.conversation.needs_human, false);

// notes hidden from widget; close creates new conversation next time
await j(`/api/conversations/${convs[0].id}/note`, 'POST', { body: 'secret' }, ck);
const re = await j('/api/widget/init', 'POST', { key, vid });
assert.ok(!re.body.messages.some(m => m.body === 'secret')); assert.ok(re.body.messages.some(m => m.body === 'Hi, agent here'));
await j(`/api/conversations/${convs[0].id}/status`, 'POST', { status: 'closed' }, ck);
assert.equal((await j('/api/widget/init', 'POST', { key, vid })).body.messages.length, 0);

// identify, validation, admin-only, settings
assert.equal((await j('/api/widget/identify', 'POST', { key, vid, email: 'bad' })).status, 400);
assert.equal((await j('/api/widget/identify', 'POST', { key, vid, email: 'a@b.co', name: 'Ann' })).status, 200);
assert.equal((await j('/api/agents', 'POST', { name: 'Bob', email: 'bob@x.co', password: 'secret1' }, ck)).status, 200);
const bob = (await j('/api/auth/login', 'POST', { email: 'bob@x.co', password: 'secret1' })).headers.get('set-cookie').split(';')[0];
assert.equal((await j('/api/settings', 'PUT', { title: 'x' }, bob)).status, 403);
assert.equal((await j('/api/settings', 'PUT', { title: 'Hey' }, ck)).status, 200);
assert.equal((await j('/api/widget/init', 'POST', { key, vid })).body.settings.title, 'Hey');
assert.equal((await j('/api/bot/test', 'POST', { text: 'shipping cost' }, ck)).status, 200);
assert.equal((await fetch(B + '/widget.js')).status, 200);
assert.equal((await fetch(B + '/app/')).status, 200);
assert.equal((await fetch(B + '/..%2f..%2fetc/passwd')).status, 403);

// ---- v2 features ----
const vid2 = 'vtest2222222222';
await j('/api/widget/message', 'POST', { key, vid: vid2, body: 'what is your return policy' }); await sleep(1000);
const c2 = (await j('/api/conversations?status=open', 'GET', null, ck)).body.conversations.find(c => c.visitor.id === vid2);
const m2 = (await j('/api/conversations/' + c2.id, 'GET', null, ck)).body.messages;
assert.match(m2.at(-1).body, /30 days/, 'KB answer');
// uploads
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
assert.equal((await j('/api/widget/upload', 'POST', { key, vid: vid2, name: 'a.exe', type: 'application/x-msdownload', data: 'AAAA' })).status, 400);
const up = await j('/api/widget/upload', 'POST', { key, vid: vid2, name: 'pic.png', type: 'image/png', data: png });
assert.equal(up.status, 200);
const fr = await fetch(B + up.body.message.attachment.url);
assert.equal(fr.status, 200); assert.equal(fr.headers.get('content-type'), 'image/png'); assert.equal(fr.headers.get('x-content-type-options'), 'nosniff');
assert.equal((await fetch(B + '/uploads/..%2fpackage.json')).status, 404);
assert.equal((await j(`/api/conversations/${c2.id}/upload`, 'POST', { name: 'n.txt', type: 'text/plain', data: Buffer.from('hi').toString('base64') }, ck)).status, 200);
// close + rating
await j(`/api/conversations/${c2.id}/status`, 'POST', { status: 'closed' }, ck);
assert.equal((await j('/api/widget/rate', 'POST', { key, vid: vid2, rating: 9 })).status, 400);
assert.equal((await j('/api/widget/rate', 'POST', { key, vid: vid2, rating: 5, comment: 'great' })).status, 200);
assert.equal((await j('/api/widget/rate', 'POST', { key, vid: vid2, rating: 5 })).status, 404);
const an = (await j('/api/analytics', 'GET', null, ck)).body;
assert.equal(an.csat, 5); assert.equal(an.days.length, 14); assert.ok(an.avgFirstResponseSec !== null);
// KB admin, transcript, contacts, hours, webhook validation
assert.equal((await j('/api/kb', 'POST', { question: 'q?', answer: 'a' }, bob)).status, 403);
assert.equal((await j('/api/kb', 'POST', { question: 'Do you ship abroad?', answer: 'Yes, worldwide.' }, ck)).status, 200);
const tr = await fetch(B + `/api/conversations/${c2.id}/transcript`, { headers: { cookie: ck } });
assert.match(await tr.text(), /return policy/);
assert.match(await (await fetch(B + '/api/export/contacts.csv', { headers: { cookie: ck } })).text(), /a@b\.co/);
assert.equal((await j('/api/settings', 'PUT', { webhookUrl: 'ftp://x' }, ck)).status, 400);
assert.equal((await j('/api/settings', 'PUT', { timezone: 'Nope/Zone' }, ck)).status, 400);
await j('/api/settings', 'PUT', { businessHoursEnabled: true, hoursStart: '00:00', hoursEnd: '00:01', timezone: 'UTC', hoursDays: '' }, ck);
assert.equal((await j('/api/widget/init', 'POST', { key, vid })).body.agentsOnline, false, 'outside business hours');
await j('/api/settings', 'PUT', { businessHoursEnabled: false }, ck);
console.log('all smoke tests passed');
ac.abort(); server.closeAllConnections?.(); server.close(); process.exit(0);
