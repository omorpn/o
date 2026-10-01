// Tickets: create (manual + from chat), visibility, updates & history, replies, SLA, auto-close, merge, bulk, settings, realtime, notifications.
import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
process.env.SLA_CHECK_MS = '3600000';
const { server } = await import('../server/index.js');
const { db } = await import('../server/core/db.js');
const { runTicketSla } = await import('../server/modules/tickets/index.js');
const { autoClose } = await import('../server/modules/tickets/service.js');
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
assert.ok(me.permissions.includes('tickets.manage'));
const roles = (await j('/api/roles', 'GET', null, owner)).body.roles, roleId = n => roles.find(r => r.name === n).id;
assert.deepEqual(roles.find(r => r.name === 'Agent').permissions.filter(p => p.startsWith('tickets.')).sort(), ['tickets.reply', 'tickets.view']);
for (const [name, role] of [['Ann', 'Agent'], ['Bob', 'Agent'], ['Vic', 'Viewer']]) await j('/api/members', 'POST', { name, email: `${name.toLowerCase()}@co.com`, password: 'password1', role_id: roleId(role) }, owner);
const members = (await j('/api/members', 'GET', null, owner)).body.members, uid = n => members.find(m => m.name === n).id;
const [ann, bob, vic] = await Promise.all(['ann', 'bob', 'vic'].map(n => login(`${n}@co.com`)));

// ---------- create ----------
assert.equal((await j('/api/tickets', 'POST', { subject: '' }, owner)).status, 400);
assert.equal((await j('/api/tickets', 'POST', { subject: 'x', requester_email: 'nope' }, owner)).status, 400);
assert.equal((await j('/api/tickets', 'POST', { subject: 'x' }, vic)).status, 403, 'viewers cannot create tickets');
const annLive = listen(ann); await sleep(150);
const t1 = (await j('/api/tickets', 'POST', { subject: 'Order #1001 never arrived', body: 'Hi, my order has not arrived after 2 weeks.', requester_email: 'Kemi@Shop.ng', requester_name: 'Kemi', priority: 'high', tags: ['Delivery'] }, owner)).body.ticket;
assert.equal(t1.number, 1); assert.equal(t1.status, 'open'); assert.equal(t1.requester_email, 'kemi@shop.ng'); assert.deepEqual(t1.tags, ['delivery']);
assert.ok(t1.first_response_due - t1.created === 4 * 3600_000 && t1.due_at - t1.created === 24 * 3600_000, 'high priority SLA: 4h first response, 24h resolution');
const t2 = (await j('/api/tickets', 'POST', { subject: 'Refund request', body: 'Please refund', requester_email: 'kemi@shop.ng', assignee_id: uid('Bob') }, owner)).body.ticket;
assert.equal(t2.number, 2); assert.equal(t2.assignee_name, 'Bob');
await sleep(150);
assert.ok(annLive.events.some(e => e[0] === 'ticket' && e[1].id === t1.id), 'realtime ticket event');
assert.ok(!annLive.events.some(e => e[0] === 'ticket' && e[1].id === t2.id), "agents don't receive other agents' tickets");
assert.ok(annLive.events.some(e => e[0] === 'notification' && /New ticket #1/.test(e[1].title)), 'unassigned ticket notifies the team');

// ---------- visibility ----------
let list = (await j('/api/tickets', 'GET', null, ann)).body;
assert.deepEqual(list.tickets.map(t => t.number), [1], 'agent sees unassigned + own only');
assert.equal((await j('/api/tickets/' + t2.id, 'GET', null, ann)).status, 404);
list = (await j('/api/tickets', 'GET', null, vic)).body;
assert.equal(list.tickets.length, 2, 'viewer has tickets.view_all'); assert.equal(list.counts.unassigned, 1);
assert.equal((await j('/api/tickets/' + t1.id, 'PUT', { priority: 'low' }, vic)).status, 403, 'viewer is read-only');
assert.equal((await j('/api/tickets?q=%231001', 'GET', null, owner)).body.tickets.length, 1, 'search subject');
assert.equal((await j('/api/tickets?q=2', 'GET', null, owner)).body.tickets[0].number, 2, 'search by number');

// ---------- update & history ----------
assert.equal((await j('/api/tickets/' + t1.id, 'PUT', { status: 'weird' }, ann)).status, 400);
assert.equal((await j('/api/tickets/' + t1.id, 'PUT', { assignee_id: uid('Bob') }, ann)).status, 403, 'agents can only take tickets themselves');
let u = (await j('/api/tickets/' + t1.id, 'PUT', { assignee_id: uid('Ann'), priority: 'urgent' }, ann)).body.ticket;
assert.equal(u.assignee_name, 'Ann'); assert.equal(u.due_at - u.created, 4 * 3600_000, 'SLA recalculated on priority change');
let full = (await j('/api/tickets/' + t1.id, 'GET', null, owner)).body;
assert.ok(full.events.some(e => e.detail === 'Assignee: — → Ann') && full.events.some(e => e.detail === 'Priority: high → urgent'), 'history records changes');
assert.deepEqual(full.others.map(o => o.number), [2], "requester's other tickets listed");

// ---------- replies ----------
assert.equal((await j(`/api/tickets/${t1.id}/reply`, 'POST', { body: '' }, ann)).status, 400);
let r = (await j(`/api/tickets/${t1.id}/reply`, 'POST', { body: 'Sorry Kemi — checking with the courier now.' }, ann)).body;
assert.equal(r.ticket.status, 'pending', 'public reply → pending'); assert.ok(r.ticket.first_response_at);
r = (await j(`/api/tickets/${t1.id}/reply`, 'POST', { body: 'Courier says Tuesday @Bob', note: true }, ann)).body;
assert.equal(r.message.kind, 'note'); assert.equal(r.ticket.status, 'pending');
r = (await j(`/api/tickets/${t1.id}/reply`, 'POST', { body: 'It will arrive Tuesday.', status: 'solved' }, ann)).body;
assert.equal(r.ticket.status, 'solved'); assert.ok(r.ticket.solved_at);
const noMail = (await j('/api/tickets', 'POST', { subject: 'Internal task' }, owner)).body.ticket;
assert.equal((await j(`/api/tickets/${noMail.id}/reply`, 'POST', { body: 'hello' }, owner)).status, 400, 'no requester email → notes only');
assert.equal((await j(`/api/tickets/${noMail.id}/reply`, 'POST', { body: 'todo', note: true }, owner)).status, 200);

// ---------- auto-close & reopen ----------
db.prepare('UPDATE tickets SET solved_at=? WHERE id=?').run(Date.now() - 5 * 86400_000, t1.id);
assert.equal(autoClose(), 1);
assert.equal((await j('/api/tickets/' + t1.id, 'GET', null, owner)).body.ticket.status, 'closed');
assert.equal((await j(`/api/tickets/${t1.id}/reply`, 'POST', { body: 'more' }, ann)).status, 400, 'closed tickets are read-only');
assert.equal((await j('/api/tickets/' + t1.id, 'PUT', { priority: 'low' }, ann)).status, 400);
assert.equal((await j('/api/tickets/' + t1.id, 'PUT', { status: 'open' }, ann)).body.ticket.status, 'open', 'reopen');

// ---------- SLA ----------
db.prepare('UPDATE tickets SET first_response_due=? WHERE id=?').run(Date.now() - 1000, t2.id);
const bobLive = listen(bob); await sleep(150);
assert.equal(runTicketSla(), 1); assert.equal(runTicketSla(), 0, 'one alert per breach');
await sleep(150);
assert.ok(bobLive.events.some(e => e[0] === 'notification' && /SLA breached: #2/.test(e[1].title)), 'assignee alerted');
assert.equal((await j('/api/tickets?view=overdue', 'GET', null, owner)).body.tickets[0].sla, 'breached');
assert.ok((await j('/api/tickets/' + t2.id, 'GET', null, owner)).body.events.some(e => e.action === 'sla_breached'));

// ---------- custom fields & settings ----------
assert.equal((await j('/api/tickets/settings', 'PUT', { fields: [{ label: 'Order number', type: 'text' }, { label: 'Channel', type: 'select', options: 'Web, WhatsApp' }] }, ann)).status, 403);
assert.equal((await j('/api/tickets/settings', 'PUT', { fields: [{ label: 'Bad', type: 'select' }] }, owner)).status, 400);
const st = (await j('/api/tickets/settings', 'PUT', { fields: [{ label: 'Order number', type: 'text' }, { label: 'Sales channel', type: 'select', options: 'Web, WhatsApp' }, { label: 'Amount', type: 'number' }],
  sla: { urgent: [1, 2], high: [2, 8], normal: [4, 24], low: [0, 0] }, autoCloseDays: 7 }, owner)).body;
assert.deepEqual(st.fields.map(f => f.key), ['order_number', 'sales_channel', 'amount']); assert.equal(st.autoCloseDays, 7);
assert.equal((await j('/api/tickets/' + t2.id, 'PUT', { custom: { sales_channel: 'Fax' } }, owner)).status, 400);
assert.equal((await j('/api/tickets/' + t2.id, 'PUT', { custom: { amount: 'lots' } }, owner)).status, 400);
u = (await j('/api/tickets/' + t2.id, 'PUT', { custom: { order_number: 'A-1001', sales_channel: 'WhatsApp', amount: '25000', unknown: 'x' } }, owner)).body.ticket;
assert.deepEqual(u.custom, { order_number: 'A-1001', sales_channel: 'WhatsApp', amount: 25000 });
const low = (await j('/api/tickets', 'POST', { subject: 'Low prio', priority: 'low' }, owner)).body.ticket;
assert.equal(low.due_at, null, '0 hours = no SLA target'); assert.equal(low.sla, null);

// ---------- from chat ----------
await j(`/api/settings?site=${SITE}`, 'PUT', { botEnabled: false }, owner);
await j('/api/widget/identify', 'POST', { key, vid: 'visitorTICKET01', name: 'Tunde', email: 'tunde@x.ng' });
await j('/api/widget/message', 'POST', { key, vid: 'visitorTICKET01', body: 'My payment failed twice' });
const conv = db.prepare("SELECT * FROM conversations WHERE visitor_id=?").get(`${SITE}:visitorTICKET01`);
const ct = (await j(`/api/conversations/${conv.id}/ticket`, 'POST', { priority: 'high' }, ann)).body.ticket;
assert.equal(ct.subject, 'My payment failed twice'); assert.equal(ct.channel, 'chat'); assert.equal(ct.requester_email, 'tunde@x.ng'); assert.equal(ct.assignee_name, 'Ann'); assert.equal(ct.conversation_id, conv.id);
full = (await j('/api/tickets/' + ct.id, 'GET', null, ann)).body;
assert.ok(full.messages[0].kind === 'note' && /My payment failed twice/.test(full.messages[0].body), 'transcript attached as note');
assert.ok(db.prepare("SELECT 1 FROM messages WHERE conv_id=? AND sender='note' AND body LIKE '%created ticket #%'").get(conv.id), 'chat gets a note linking the ticket');
assert.equal((await j(`/api/tickets?conversation=${conv.id}`, 'GET', null, ann)).body.tickets.length, 1);

// ---------- merge ----------
assert.equal((await j(`/api/tickets/${t2.id}/merge`, 'POST', { into: t1.id }, ann)).status, 403);
assert.equal((await j(`/api/tickets/${t2.id}/merge`, 'POST', { into: t2.id }, owner)).status, 400);
const before = db.prepare('SELECT COUNT(*) n FROM ticket_messages WHERE ticket_id IN (?,?)').get(t1.id, t2.id).n;
assert.equal((await j(`/api/tickets/${t2.id}/merge`, 'POST', { into: t1.id }, owner)).status, 200);
full = (await j('/api/tickets/' + t1.id, 'GET', null, owner)).body;
assert.equal(full.messages.length, before + 1, 'messages moved + merge note'); assert.deepEqual(full.merged.map(m => m.number), [2]);
assert.ok(!(await j('/api/tickets?status=all', 'GET', null, owner)).body.tickets.some(t => t.id === t2.id), 'merged tickets leave lists');

// ---------- bulk ----------
const ids = [t1.id, noMail.id, low.id];
assert.equal((await j('/api/tickets/bulk', 'POST', { ids, action: 'explode' }, owner)).status, 400);
assert.equal((await j('/api/tickets/bulk', 'POST', { ids, action: 'priority', value: 'high' }, owner)).body.updated, 3);
assert.equal((await j('/api/tickets/bulk', 'POST', { ids, action: 'tag', value: 'vip' }, owner)).body.updated, 3);
assert.equal((await j('/api/tickets/bulk', 'POST', { ids, action: 'status', value: 'solved' }, ann)).body.updated, 3, 'Ann sees t1 (hers) and the two unassigned');
assert.equal((await j('/api/tickets/bulk', 'POST', { ids, action: 'delete' }, ann)).status, 403);
assert.equal((await j('/api/tickets/bulk', 'POST', { ids: [low.id], action: 'delete' }, owner)).body.updated, 1);
assert.equal((await j('/api/tickets/' + low.id, 'GET', null, owner)).status, 404);

// ---------- module off ----------
await j('/api/modules/tickets', 'PUT', { enabled: false }, owner);
assert.equal((await j('/api/tickets', 'GET', null, owner)).status, 403);
await j('/api/modules/tickets', 'PUT', { enabled: true }, owner);
assert.ok((await j('/api/audit', 'GET', null, owner)).body.entries.some(e => e.action === 'ticket.merged'));

annLive.stop(); bobLive.stop();
console.log('all ticket tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
