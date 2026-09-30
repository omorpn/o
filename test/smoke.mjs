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
console.log('all smoke tests passed');
ac.abort(); server.closeAllConnections?.(); server.close(); process.exit(0);
