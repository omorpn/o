// Departments & routing, agent availability, and inbox upgrades: priority, snooze, saved views, bulk actions.
import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
process.env.SLA_CHECK_MS = '3600000';
const { server } = await import('../server/index.js');
const { db } = await import('../server/core/db.js');
const { wakeSnoozed } = await import('../server/modules/livechat/index.js');
await new Promise(r => server.listen(0, r));
const B = `http://localhost:${server.address().port}`;
const j = async (p, method = 'GET', body, cookie) => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieOf = r => r.headers.get('set-cookie').split(';')[0];
const listen = ck => {
  const events = [], ac = new AbortController();
  fetch(B + '/api/events', { headers: { cookie: ck }, signal: ac.signal }).then(async r => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) { buf += dec.decode(c); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const m = f.match(/event: ([\w.]+)\ndata: (.*)/); if (m) events.push([m[1], JSON.parse(m[2])]); } }
  }).catch(() => {});
  return { events, stop: () => ac.abort() };
};
const login = async (email, password = 'password1') => cookieOf(await j('/api/auth/login', 'POST', { email, password }));

const owner = await login('admin@example.com', 'admin123');
const me = (await j('/api/me', 'GET', null, owner)).body, SITE = me.sites[0].id, key = me.sites[0].site_key;
assert.equal(me.user.status, 'available');
await j(`/api/settings?site=${SITE}`, 'PUT', { botEnabled: false }, owner); // chats go straight to the team
const roles = (await j('/api/roles', 'GET', null, owner)).body.roles, roleId = n => roles.find(r => r.name === n).id;
for (const [name, role] of [['Ann', 'Agent'], ['Bob', 'Agent'], ['Cat', 'Agent'], ['Vic', 'Viewer']]) {
  assert.equal((await j('/api/members', 'POST', { name, email: `${name.toLowerCase()}@co.com`, password: 'password1', role_id: roleId(role) }, owner)).status, 200);
}
const members = (await j('/api/members', 'GET', null, owner)).body.members, uid = n => members.find(m => m.name === n).id;
const [ann, bob, cat, vic] = await Promise.all(['ann', 'bob', 'cat', 'vic'].map(n => login(`${n}@co.com`)));
const say = (vid, body, extra = {}) => j('/api/widget/message', 'POST', { key, vid, body, ...extra });
const convOf = vid => db.prepare('SELECT * FROM conversations WHERE visitor_id=? ORDER BY id DESC').get(`${SITE}:${vid}`);

// ---------- departments CRUD & permissions ----------
assert.equal((await j('/api/departments', 'POST', { name: 'Sales' }, ann)).status, 403, 'agents cannot manage departments');
assert.equal((await j('/api/departments', 'POST', { name: 'Sales', members: [uid('Vic')] }, owner)).status, 400, "viewers can't join (can't reply)");
const sales = (await j('/api/departments', 'POST', { name: 'Sales', color: '#10b981', members: [uid('Ann'), uid('Bob')] }, owner)).body.department;
const support = (await j('/api/departments', 'POST', { name: 'Support', members: [uid('Cat')], public: false }, owner)).body.department;
assert.deepEqual(sales.members.sort(), [uid('Ann'), uid('Bob')].sort());
assert.equal((await j('/api/departments', 'POST', { name: 'sales' }, owner)).status, 409);
let d = (await j('/api/departments', 'GET', null, ann)).body;
assert.equal(d.departments.length, 2); assert.equal(d.routing.assignmentMode, 'manual');

// ---------- manual mode: nobody auto-assigned ----------
const agents = { ann: listen(ann), bob: listen(bob), cat: listen(cat) };
await sleep(200);
await say('visitorMANUAL1', 'hello there'); await sleep(100);
assert.equal(convOf('visitorMANUAL1').assignee_id, null);

// ---------- round robin ----------
assert.equal((await j('/api/routing', 'PUT', { assignmentMode: 'nope' }, owner)).status, 400);
const rr = (await j('/api/routing', 'PUT', { assignmentMode: 'round_robin' }, owner)).body;
assert.equal(rr.routing.assignmentMode, 'round_robin'); assert.equal(rr.routed, 1, 'switching on routing hands out the waiting chat');
const first = convOf('visitorMANUAL1').assignee_id; assert.ok([uid('Ann'), uid('Bob'), uid('Cat')].includes(first));
const got = [];
for (let i = 0; i < 4; i++) { await say('visitorRR000' + i, 'hi ' + i); got.push(convOf('visitorRR000' + i).assignee_id); }
// owner is not connected; the three connected agents rotate
assert.equal(new Set(got.slice(0, 3)).size, 3, 'round robin spreads chats over every available agent');
assert.ok(!got.includes(me.user.id), 'offline teammates get nothing');
await sleep(150);
const annNote = agents.ann.events.find(e => e[0] === 'notification' && /routed to you/.test(e[1].title));
assert.ok(got.includes(uid('Ann')) && annNote, 'routed agent is notified');

// ---------- away status ----------
assert.equal((await j('/api/me/status', 'PUT', { status: 'busy' }, bob)).status, 400);
assert.equal((await j('/api/me/status', 'PUT', { status: 'away' }, bob)).body.status, 'away');
assert.equal((await j('/api/members', 'GET', null, owner)).body.members.find(m => m.name === 'Bob').status, 'away');
for (let i = 0; i < 4; i++) { await say('visitorAWAY00' + i, 'yo'); assert.notEqual(convOf('visitorAWAY00' + i).assignee_id, uid('Bob'), 'away agents get no chats'); }

// ---------- departments: chats from the widget picker go to that team ----------
let init = (await j('/api/widget/init', 'POST', { key, vid: 'visitorDEPT0001' })).body;
assert.deepEqual(init.settings.departments, [], 'picker off by default');
await j('/api/routing', 'PUT', { widgetDepartments: true }, owner);
init = (await j('/api/widget/init', 'POST', { key, vid: 'visitorDEPT0001' })).body;
assert.deepEqual(init.settings.departments.map(x => x.name), ['Sales'], 'only public departments are offered');
await say('visitorDEPT0001', 'pricing question', { department_id: sales.id });
let c1 = convOf('visitorDEPT0001');
assert.equal(c1.department_id, sales.id); assert.equal(c1.assignee_id, uid('Ann'), 'Sales has Ann (Bob is away)');
await say('visitorDEPT0002', 'sneaky', { department_id: support.id });
assert.equal(convOf('visitorDEPT0002').department_id, null, 'private departments cannot be picked by visitors');
// Sales with nobody available queues the chat
await j('/api/me/status', 'PUT', { status: 'away' }, ann);
await say('visitorDEPT0003', 'anyone in sales?', { department_id: sales.id });
assert.equal(convOf('visitorDEPT0003').assignee_id, null, 'queued while the department is away');
await j('/api/me/status', 'PUT', { status: 'available' }, bob); await sleep(100);
assert.equal(convOf('visitorDEPT0003').assignee_id, uid('Bob'), 'queue drains when someone becomes available');
await j('/api/me/status', 'PUT', { status: 'available' }, ann);

// ---------- least busy & max chats ----------
await j('/api/routing', 'PUT', { assignmentMode: 'least_busy', maxChats: 0 }, owner);
const load = n => db.prepare("SELECT COUNT(*) n FROM conversations WHERE assignee_id=? AND status='open'").get(uid(n)).n;
await say('visitorLB000001', 'least busy please');
const lbPick = convOf('visitorLB000001').assignee_id;
const loads = { Ann: load('Ann'), Bob: load('Bob'), Cat: load('Cat') };
assert.ok(Object.entries(loads).every(([n, l]) => uid(n) === lbPick || l >= loads[members.find(m => m.id === lbPick).name] - 1), 'picked one of the least loaded');
const max = Math.max(...Object.values(loads));
await j('/api/routing', 'PUT', { maxChats: Math.min(...Object.values(loads)) }, owner);
await say('visitorMAX00001', 'over capacity?');
assert.equal(convOf('visitorMAX00001').assignee_id, null, 'nobody under the max concurrent chats → waits in queue');
await j('/api/routing', 'PUT', { maxChats: max + 5 }, owner);
assert.ok(convOf('visitorMAX00001').assignee_id, 'raising the limit drains the queue');

// ---------- transfer between departments ----------
const cid = convOf('visitorDEPT0001').id;
assert.equal((await j(`/api/conversations/${cid}/department`, 'POST', { department_id: support.id }, ann)).status, 403, 'agents lack chats.assign');
assert.equal((await j(`/api/conversations/${cid}/department`, 'POST', { department_id: 99999 }, owner)).status, 400);
assert.equal((await j(`/api/conversations/${cid}/department`, 'POST', { department_id: support.id }, owner)).status, 200);
const moved = (await j(`/api/conversations/${cid}`, 'GET', null, owner)).body;
assert.equal(moved.conversation.department_name, 'Support'); assert.equal(moved.conversation.assignee_id, uid('Cat'), 'transfer re-routes inside the new department');
assert.ok(moved.messages.some(m => m.sender === 'note' && /transferred this conversation to Support/.test(m.body)));

// ---------- flows hand off to a department ----------
const nodes = [{ id: 'a', type: 'handoff', text: 'Passing you to billing', department: support.id }];
await j(`/api/settings?site=${SITE}`, 'PUT', { botEnabled: true }, owner);
assert.equal((await j(`/api/flows?site=${SITE}`, 'POST', { name: 'Billing', keywords: 'invoice, refund', nodes: [{ id: 'a', type: 'handoff', text: 'x', department: 'x' }] }, owner)).status, 400);
assert.equal((await j(`/api/flows?site=${SITE}`, 'POST', { name: 'Billing', keywords: 'invoice, refund', nodes }, owner)).status, 200);
await say('visitorFLOW0001', 'I need a refund for my invoice'); await sleep(1500);
const fc = convOf('visitorFLOW0001');
assert.equal(fc.department_id, support.id); assert.equal(fc.needs_human, 1); assert.equal(fc.assignee_id, uid('Cat'));
await j(`/api/settings?site=${SITE}`, 'PUT', { botEnabled: false }, owner);

// ---------- priority ----------
const pid = convOf('visitorRR0000').id;
assert.equal((await j(`/api/conversations/${pid}/priority`, 'POST', { priority: 'meh' }, owner)).status, 400);
assert.equal((await j(`/api/conversations/${pid}/priority`, 'POST', { priority: 'urgent' }, owner)).status, 200);
let list = (await j('/api/conversations?status=open', 'GET', null, owner)).body.conversations;
assert.equal(list.find(c => c.id === pid).priority, 'urgent');
assert.equal(list.filter(c => !c.needs_human)[0].id, pid, 'urgent chats sort first');
assert.deepEqual((await j('/api/conversations?status=open&priority=urgent', 'GET', null, owner)).body.conversations.map(c => c.id), [pid]);
assert.ok((await j(`/api/conversations?status=open&department=${support.id}`, 'GET', null, owner)).body.conversations.every(c => c.department_id === support.id));
assert.ok((await j(`/api/conversations?status=open&assignee=${uid('Cat')}`, 'GET', null, owner)).body.conversations.every(c => c.assignee_id === uid('Cat')));

// ---------- snooze ----------
assert.equal((await j(`/api/conversations/${pid}/snooze`, 'POST', { until: Date.now() - 1000 }, owner)).status, 400);
assert.equal((await j(`/api/conversations/${pid}/snooze`, 'POST', { until: Date.now() + 3600_000 }, owner)).status, 200);
list = (await j('/api/conversations?status=open', 'GET', null, owner)).body.conversations;
assert.ok(!list.some(c => c.id === pid), 'snoozed chats leave the open list');
assert.deepEqual((await j('/api/conversations?status=open&filter=snoozed', 'GET', null, owner)).body.conversations.map(c => c.id), [pid]);
await say('visitorRR0000', 'hello? still there?'); await sleep(50);
assert.equal(convOf('visitorRR0000').snoozed_until, null, 'a visitor message wakes it up');
await j(`/api/conversations/${pid}/snooze`, 'POST', { until: Date.now() + 3600_000 }, owner);
db.prepare('UPDATE conversations SET snoozed_until=? WHERE id=?').run(Date.now() - 1, pid);
assert.equal(wakeSnoozed(), 1); assert.equal(convOf('visitorRR0000').snoozed_until, null, 'timer wakes it up');

// ---------- saved views ----------
assert.equal((await j('/api/inbox/views', 'POST', { name: 'Urgent sales', filters: { priority: 'urgent', department: sales.id, evil: 'x' } }, ann)).status, 200);
assert.equal((await j('/api/inbox/views', 'POST', { name: 'Team view', filters: { filter: 'unassigned' }, shared: true }, ann)).status, 403, 'shared views need settings.manage');
assert.equal((await j('/api/inbox/views', 'POST', { name: 'Team view', filters: { filter: 'unassigned' }, shared: true }, owner)).status, 200);
let views = (await j('/api/inbox/views', 'GET', null, ann)).body.views;
assert.deepEqual(views.map(v => v.name).sort(), ['Team view', 'Urgent sales']);
const mine = views.find(v => v.name === 'Urgent sales'); assert.deepEqual(mine.filters, { priority: 'urgent', department: String(sales.id) });
assert.ok(!(await j('/api/inbox/views', 'GET', null, bob)).body.views.some(v => v.name === 'Urgent sales'), 'personal views are private');
assert.equal((await j('/api/inbox/views/' + views.find(v => v.shared).id, 'DELETE', null, ann)).status, 403);
assert.equal((await j('/api/inbox/views/' + mine.id, 'DELETE', null, bob)).status, 404);
assert.equal((await j('/api/inbox/views/' + mine.id, 'DELETE', null, ann)).status, 200);

// ---------- bulk actions ----------
const ids = ['visitorAWAY000', 'visitorAWAY001', 'visitorAWAY002'].map(v => convOf(v).id);
assert.equal((await j('/api/conversations/bulk', 'POST', { ids: [], action: 'close' }, owner)).status, 400);
assert.equal((await j('/api/conversations/bulk', 'POST', { ids, action: 'explode' }, owner)).status, 400);
assert.equal((await j('/api/conversations/bulk', 'POST', { ids, action: 'priority', value: 'high' }, owner)).body.updated, 3);
assert.equal((await j('/api/conversations/bulk', 'POST', { ids, action: 'tag', value: 'vip' }, owner)).body.updated, 3);
assert.equal((await j('/api/conversations/bulk', 'POST', { ids, action: 'assign', value: uid('Cat') }, owner)).body.updated, 3);
for (const id of ids) { const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(id); assert.equal(c.priority, 'high'); assert.deepEqual(JSON.parse(c.tags), ['vip']); assert.equal(c.assignee_id, uid('Cat')); }
assert.equal((await j('/api/conversations/bulk', 'POST', { ids, action: 'assign', value: uid('Ann') }, cat)).status, 403, 'bulk respects permissions');
// an agent only touches chats they can see
const vicIds = [...ids, convOf('visitorDEPT0003').id];
assert.equal((await j('/api/conversations/bulk', 'POST', { ids: vicIds, action: 'close' }, cat)).body.updated, 3, "Cat can't see Bob's chat, so it is skipped");
assert.ok(ids.every(id => db.prepare('SELECT status FROM conversations WHERE id=?').get(id).status === 'closed'));
assert.equal((await j('/api/conversations/bulk', 'POST', { ids, action: 'reopen' }, owner)).body.updated, 3);
assert.equal((await j('/api/conversations/bulk', 'POST', { ids, action: 'delete' }, cat)).status, 403);
assert.equal((await j('/api/conversations/bulk', 'POST', { ids, action: 'delete' }, owner)).body.updated, 3);
assert.ok(ids.every(id => !db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id)));

// ---------- module off: no routing, transfer refused ----------
await j('/api/modules/departments', 'PUT', { enabled: false }, owner);
await say('visitorOFF00001', 'module off');
assert.equal(convOf('visitorOFF00001').assignee_id, null);
assert.equal((await j('/api/departments', 'GET', null, owner)).status, 403);
assert.equal((await j(`/api/conversations/${convOf('visitorOFF00001').id}/department`, 'POST', { department_id: sales.id }, owner)).status, 403);
assert.deepEqual((await j('/api/widget/init', 'POST', { key, vid: 'visitorDEPT0001' })).body.settings.departments, []);
await j('/api/modules/departments', 'PUT', { enabled: true }, owner);
assert.equal((await j('/api/departments/' + sales.id, 'DELETE', null, owner)).status, 200);
assert.equal(convOf('visitorDEPT0003').department_id, null, 'deleting a department keeps its chats');

for (const a of Object.values(agents)) a.stop();
console.log('all routing tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
