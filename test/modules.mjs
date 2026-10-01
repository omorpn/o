// Feature modules: per-workspace toggles, plan availability, route gating and widget behaviour.
import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
const { server } = await import('../server/index.js');
const { routeList } = await import('../server/core/router.js');
await new Promise(r => server.listen(0, r));
const B = `http://localhost:${server.address().port}`;
const j = async (p, method = 'GET', body, cookie) => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieOf = r => r.headers.get('set-cookie').split(';')[0];
const root = cookieOf(await j('/api/auth/login', 'POST', { email: 'admin@example.com', password: 'admin123' }));
const owner = cookieOf(await j('/api/auth/signup', 'POST', { name: 'Olu', email: 'olu@shop.co', password: 'password1', workspace: 'Shop', elapsed: 9000 }));
const me = (await j('/api/me', 'GET', null, owner)).body, SITE = me.sites[0].id, key = me.sites[0].site_key;

// every route belongs to a module and declares its auth level
const routes = routeList();
assert.ok(routes.length > 80 && routes.every(r => r.module && r.auth), 'routes are declared by modules');

// default: every feature module on
const keys = me.modules.map(m => m.key);
for (const k of ['livechat', 'chatbot', 'flows', 'ai', 'triggers', 'contacts', 'analytics', 'spam', 'webhooks']) assert.ok(keys.includes(k), 'module listed: ' + k);
assert.ok(me.modules.find(m => m.key === 'livechat').core);
assert.ok(me.modules.filter(m => !m.core).every(m => m.enabled && m.available));

// core cannot be disabled; unknown module 404; agents cannot toggle
assert.equal((await j('/api/modules/livechat', 'PUT', { enabled: false }, owner)).status, 400);
assert.equal((await j('/api/modules/nope', 'PUT', { enabled: false }, owner)).status, 404);
const roles = (await j('/api/roles', 'GET', null, owner)).body.roles;
await j('/api/members', 'POST', { name: 'Ann', email: 'ann@shop.co', password: 'password1', role_id: roles.find(r => r.name === 'Agent').id }, owner);
const agent = cookieOf(await j('/api/auth/login', 'POST', { email: 'ann@shop.co', password: 'password1' }));
assert.equal((await j('/api/modules/contacts', 'PUT', { enabled: false }, agent)).status, 403);

// disabling a module gates its API with a clear error
assert.equal((await j('/api/modules/contacts', 'PUT', { enabled: false }, owner)).status, 200);
const gated = await j('/api/contacts', 'GET', null, owner);
assert.equal(gated.status, 403); assert.equal(gated.body.module, 'contacts'); assert.match(gated.body.error, /Contacts module is not enabled/);
assert.equal((await j('/api/conversations', 'GET', null, owner)).status, 200, 'core routes unaffected');
await j('/api/modules/contacts', 'PUT', { enabled: true }, owner);
assert.equal((await j('/api/contacts', 'GET', null, owner)).status, 200);
assert.ok((await j('/api/audit', 'GET', null, owner)).body.entries.some(e => e.action === 'module.disabled' && e.detail === 'Contacts'));

// triggers module off → widget gets no triggers
assert.ok((await j('/api/widget/init', 'POST', { key, vid: 'visitorMOD0001' })).body.settings.triggers.length > 0);
await j('/api/modules/triggers', 'PUT', { enabled: false }, owner);
assert.deepEqual((await j('/api/widget/init', 'POST', { key, vid: 'visitorMOD0001' })).body.settings.triggers, []);
assert.equal((await j(`/api/triggers?site=${SITE}`, 'GET', null, owner)).status, 403);

// bot modules: flows off → no flow, chatbot rules still answer
const thread = async vid => { const c = (await j('/api/conversations', 'GET', null, owner)).body.conversations.find(x => x.visitor.id === `${SITE}:${vid}`); return (await j('/api/conversations/' + c.id, 'GET', null, owner)).body; };
await j('/api/modules/flows', 'PUT', { enabled: false }, owner);
await j('/api/widget/message', 'POST', { key, vid: 'visitorMOD0002', body: 'can I get a quote' }); await sleep(900);
assert.doesNotMatch((await thread('visitorMOD0002')).messages.at(-1).body, /set you up/, 'flow did not run');
await j('/api/widget/message', 'POST', { key, vid: 'visitorMOD0003', body: 'what are your prices' }); await sleep(900);
assert.match((await thread('visitorMOD0003')).messages.at(-1).body, /\$19/, 'rule still answers');
// all automation off → conversation goes straight to the team, no bot reply
await j('/api/modules/chatbot', 'PUT', { enabled: false }, owner); await j('/api/modules/ai', 'PUT', { enabled: false }, owner);
await j('/api/widget/message', 'POST', { key, vid: 'visitorMOD0004', body: 'hello' }); await sleep(900);
const t4 = await thread('visitorMOD0004');
assert.equal(t4.conversation.bot_active, false); assert.deepEqual(t4.messages.map(m => m.sender), ['visitor']);
await j('/api/modules/flows', 'PUT', { enabled: true }, owner);
await j('/api/widget/message', 'POST', { key, vid: 'visitorMOD0005', body: 'I want a quote' }); await sleep(900);
assert.ok((await thread('visitorMOD0005')).messages.some(m => /set you up/.test(m.body)), 'flows alone work');

// plans: platform limits modules per plan
const plans = (await j('/api/platform/plans', 'GET', null, root)).body;
assert.ok(plans.plans.find(p => p.plan === 'free').modules.includes('analytics'));
assert.equal((await j('/api/platform/plans/free', 'PUT', { modules: ['chatbot', 'flows', 'contacts', 'spam'] }, root)).status, 200);
assert.equal((await j('/api/platform/plans/free', 'PUT', { modules: ['chatbot'] }, owner)).status, 403, 'customers cannot edit plans');
const m2 = (await j('/api/modules', 'GET', null, owner)).body.modules;
assert.equal(m2.find(m => m.key === 'analytics').available, false); assert.equal(m2.find(m => m.key === 'analytics').enabled, false);
assert.equal((await j('/api/analytics', 'GET', null, owner)).status, 403, 'not in plan');
assert.equal((await j('/api/modules/analytics', 'PUT', { enabled: true }, owner)).status, 402, 'upgrade required');
assert.equal((await j('/api/platform/workspaces/' + me.workspace.id, 'PUT', { plan: 'pro' }, root)).status, 200);
assert.equal((await j('/api/analytics', 'GET', null, owner)).status, 200, 'upgrading the plan unlocks it');
assert.equal((await j('/api/platform/plans/nope', 'PUT', { modules: [] }, root)).status, 404);

console.log('all module tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
