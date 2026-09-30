// Multi-workspace isolation, roles/permissions and realtime scoping.
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
const cookieOf = r => r.headers.get('set-cookie').split(';')[0];
const signup = async (name, email, workspace) => { const r = await j('/api/auth/signup', 'POST', { name, email, password: 'password1', workspace }); assert.equal(r.status, 200, JSON.stringify(r.body)); return cookieOf(r); };
const login = async email => cookieOf(await j('/api/auth/login', 'POST', { email, password: 'password1' }));
const me = async ck => (await j('/api/me', 'GET', null, ck)).body;
const listen = ck => {
  const events = [], ac = new AbortController();
  fetch(B + '/api/events', { headers: { cookie: ck }, signal: ac.signal }).then(async r => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) { buf += dec.decode(c); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const m = f.match(/event: (\w+)\ndata: (.*)/); if (m) events.push([m[1], JSON.parse(m[2])]); } }
  }).catch(() => {});
  return { events, stop: () => ac.abort() };
};
const say = async (key, vid, body) => (await j('/api/widget/message', 'POST', { key, vid, body })).body;

// ---- sign-up ----
assert.equal((await j('/api/auth/signup', 'POST', { name: 'X', email: 'bad', password: 'password1' })).status, 400);
assert.equal((await j('/api/auth/signup', 'POST', { name: 'X', email: 'x@x.co', password: 'short' })).status, 400);
const alice = await signup('Alice', 'alice@acme.co', 'Acme');
const bob = await signup('Bob', 'bob@globex.co', 'Globex');
assert.equal((await j('/api/auth/signup', 'POST', { name: 'A', email: 'alice@acme.co', password: 'password1' })).status, 409);
const A = await me(alice), G = await me(bob);
assert.equal(A.workspace.name, 'Acme'); assert.equal(A.role.name, 'Owner'); assert.equal(A.sites.length, 1);
assert.ok(A.permissions.includes('workspace.manage'));

// ---- workspace isolation ----
const aSite = A.sites[0], gSite = G.sites[0];
await say(aSite.site_key, 'visitorAAAA01', 'hello acme');
await say(gSite.site_key, 'visitorGGGG01', 'hello globex');
await sleep(900);
const aConvs = (await j('/api/conversations', 'GET', null, alice)).body.conversations;
const gConvs = (await j('/api/conversations', 'GET', null, bob)).body.conversations;
assert.equal(aConvs.length, 1); assert.equal(gConvs.length, 1);
assert.equal((await j('/api/conversations/' + aConvs[0].id, 'GET', null, bob)).status, 404, 'cross-workspace read');
assert.equal((await j(`/api/conversations/${aConvs[0].id}/messages`, 'POST', { body: 'hi' }, bob)).status, 404, 'cross-workspace reply');
assert.equal((await j(`/api/settings?site=${aSite.id}`, 'GET', null, bob)).status, 404, 'cross-workspace settings');
assert.equal((await j(`/api/rules?site=${aSite.id}`, 'GET', null, bob)).status, 404);
assert.equal((await j('/api/contacts/' + encodeURIComponent(aConvs[0].visitor.id), 'GET', null, bob)).status, 404);
const aC = (await j('/api/canned', 'GET', null, alice)).body.canned.map(c => c.id), gC = (await j('/api/canned', 'GET', null, bob)).body.canned.map(c => c.id);
assert.ok(aC.length === 3 && !aC.some(id => gC.includes(id)), 'canned is per workspace');
// same visitor id on two different sites stays separate
await say(gSite.site_key, 'visitorAAAA01', 'same vid other site'); await sleep(900);
assert.equal((await j('/api/conversations', 'GET', null, alice)).body.conversations.length, 1);

// ---- multiple sites + site-restricted members ----
const s2 = (await j('/api/sites', 'POST', { name: 'Acme Shop', domain: 'shop.acme.co' }, alice)).body.site;
assert.ok(s2.site_key.startsWith('ck_'));
const roles = (await j('/api/roles', 'GET', null, alice)).body.roles; const rid = n => roles.find(r => r.name === n).id;
assert.deepEqual(roles.map(r => r.name), ['Owner', 'Admin', 'Supervisor', 'Agent', 'Viewer']);
assert.equal((await j('/api/members', 'POST', { name: 'Carl', email: 'carl@acme.co', password: 'password1', role_id: rid('Agent'), site_ids: [s2.id] }, alice)).status, 200);
assert.equal((await j('/api/members', 'POST', { name: 'Vera', email: 'vera@acme.co', password: 'password1', role_id: rid('Viewer') }, alice)).status, 200);
assert.equal((await j('/api/members', 'POST', { name: 'Adam', email: 'adam@acme.co', password: 'password1', role_id: rid('Admin') }, alice)).status, 200);
assert.equal((await j('/api/members', 'POST', { email: 'carl@acme.co', role_id: rid('Agent') }, alice)).status, 409);
const carl = await login('carl@acme.co'), vera = await login('vera@acme.co'), adam = await login('adam@acme.co');
assert.deepEqual((await me(carl)).sites.map(s => s.id), [s2.id]);
const carlLive = listen(carl), aliceLive = listen(alice); await sleep(200);
await say(s2.site_key, 'visitorSHOP01', 'shop question');
await say(aSite.site_key, 'visitorAAAA02', 'main site question');
await sleep(900);
const carlConvs = (await j('/api/conversations', 'GET', null, carl)).body.conversations;
assert.equal(carlConvs.length, 1); assert.equal(carlConvs[0].site_id, s2.id);
assert.equal((await j('/api/conversations/' + aConvs[0].id, 'GET', null, carl)).status, 404, 'site restriction');
assert.equal((await j(`/api/settings?site=${aSite.id}`, 'GET', null, carl)).status, 404);
// realtime: carl only receives events for his site, alice for both
const carlMsgs = carlLive.events.filter(e => e[0] === 'message').map(e => e[1].message.body);
const aliceMsgs = aliceLive.events.filter(e => e[0] === 'message').map(e => e[1].message.body);
assert.ok(carlMsgs.includes('shop question') && !carlMsgs.includes('main site question'), 'realtime site scoping: ' + carlMsgs);
assert.ok(aliceMsgs.includes('shop question') && aliceMsgs.includes('main site question'));
assert.ok(!carlLive.events.some(e => e[0] === 'message' && /globex|same vid/.test(e[1].message.body)));

// ---- chats.view_all: agent loses a chat assigned to someone else ----
const shopConv = carlConvs[0].id;
assert.equal((await j(`/api/conversations/${shopConv}/messages`, 'POST', { body: 'Carl here' }, carl)).status, 200);
const users = (await j('/api/members', 'GET', null, alice)).body.members; const uid = e => users.find(u => u.email === e).id;
assert.equal((await j(`/api/conversations/${shopConv}/assign`, 'POST', { agent_id: uid('carl@acme.co') }, carl)).status, 403, 'agents cannot assign');
assert.equal((await j(`/api/conversations/${shopConv}/assign`, 'POST', { agent_id: uid('vera@acme.co') }, alice)).status, 400, 'viewer cannot be assigned');
assert.equal((await j(`/api/conversations/${shopConv}/assign`, 'POST', { agent_id: uid('alice@acme.co') }, alice)).status, 200);
await sleep(100);
assert.equal((await j('/api/conversations/' + shopConv, 'GET', null, carl)).status, 404, 'assigned to someone else is hidden');
assert.ok(carlLive.events.some(e => e[0] === 'deleted' && e[1].id === shopConv), 'realtime removal');
await say(s2.site_key, 'visitorSHOP01', 'follow up for alice'); await sleep(900);
assert.ok(!carlLive.events.some(e => e[0] === 'message' && e[1].message.body === 'follow up for alice'), 'no realtime leak of hidden chat');

// ---- permission checks ----
const vConvs = (await j('/api/conversations', 'GET', null, vera)).body.conversations;
assert.ok(vConvs.length >= 2, 'viewer sees all');
assert.equal((await j(`/api/conversations/${vConvs[0].id}/messages`, 'POST', { body: 'x' }, vera)).status, 403, 'viewer cannot reply');
assert.equal((await j(`/api/conversations/${vConvs[0].id}/status`, 'POST', { status: 'closed' }, vera)).status, 403);
assert.equal((await j(`/api/settings?site=${aSite.id}`, 'PUT', { title: 'x' }, carl)).status, 404);
assert.equal((await j(`/api/settings?site=${s2.id}`, 'PUT', { title: 'x' }, carl)).status, 403, 'agent cannot change settings');
assert.equal((await j(`/api/rules?site=${s2.id}`, 'POST', { name: 'x', keywords: 'x', reply: 'y' }, carl)).status, 403);
assert.equal((await j('/api/export/contacts.csv', 'GET', null, carl)).status, 403);
assert.equal((await j('/api/analytics', 'GET', null, carl)).status, 403);
assert.equal((await j('/api/audit', 'GET', null, carl)).status, 403);
assert.equal((await j('/api/roles', 'GET', null, carl)).status, 403);
assert.equal((await j('/api/members', 'POST', { email: 'z@z.co', name: 'Z', password: 'password1', role_id: rid('Agent') }, carl)).status, 403);
assert.equal((await j('/api/conversations/' + vConvs[0].id, 'DELETE', null, carl)).status, 403);
assert.equal((await j('/api/sites', 'POST', { name: 'x' }, carl)).status, 403);
assert.equal((await j('/api/workspace', 'PUT', { name: 'x' }, adam)).status, 403, 'admin cannot rename workspace');
assert.equal((await j(`/api/settings?site=${s2.id}`, 'PUT', { title: 'Shop chat' }, adam)).status, 200, 'admin can change settings');

// ---- no privilege escalation ----
assert.equal((await j('/api/roles', 'POST', { name: 'Super', permissions: ['workspace.manage', 'chats.view'] }, adam)).status, 403, 'cannot grant perms you lack');
assert.equal((await j('/api/members', 'POST', { email: 'o@o.co', name: 'O', password: 'password1', role_id: rid('Owner') }, adam)).status, 403, 'admin cannot make owners');
assert.equal((await j('/api/members/' + uid('alice@acme.co'), 'PUT', { role_id: rid('Agent') }, adam)).status, 403, 'admin cannot demote owner');
assert.equal((await j('/api/members/' + uid('alice@acme.co'), 'DELETE', null, adam)).status, 403);
assert.equal((await j('/api/roles/' + rid('Owner'), 'PUT', { name: 'Owner', permissions: ['chats.view'] }, alice)).status, 400, 'owner role fixed');
assert.equal((await j('/api/members/' + uid('alice@acme.co'), 'PUT', { role_id: rid('Agent') }, alice)).status, 400, 'cannot change own access');
assert.equal((await j('/api/roles', 'POST', { name: 'Bogus', permissions: ['not.a.perm'] }, alice)).status, 400);

// ---- custom roles ----
const qa = await j('/api/roles', 'POST', { name: 'QA', permissions: ['chats.view', 'chats.view_all', 'analytics.view'] }, adam);
assert.equal(qa.status, 200);
assert.equal((await j('/api/roles', 'POST', { name: 'qa', permissions: ['chats.view'] }, adam)).status, 409);
assert.equal((await j('/api/members/' + uid('carl@acme.co'), 'PUT', { role_id: qa.body.id, site_ids: null }, adam)).status, 200);
const carl2 = await me(carl);
assert.equal(carl2.role.name, 'QA'); assert.equal(carl2.sites.length, 2);
assert.equal((await j('/api/analytics', 'GET', null, carl)).status, 200);
assert.equal((await j('/api/roles/' + qa.body.id, 'DELETE', null, adam)).status, 400, 'role in use');
assert.equal((await j('/api/roles/' + qa.body.id, 'PUT', { name: 'QA', permissions: ['chats.view'] }, adam)).status, 200);
assert.equal((await j('/api/analytics', 'GET', null, carl)).status, 403, 'permission change applies immediately');

// ---- multiple workspaces per user ----
assert.equal((await j('/api/members', 'POST', { email: 'carl@acme.co', role_id: (await j('/api/roles', 'GET', null, bob)).body.roles.find(r => r.name === 'Agent').id }, bob)).status, 200);
const c3 = await me(carl);
assert.equal(c3.workspaces.length, 2);
const globexId = c3.workspaces.find(w => w.name === 'Globex').id;
assert.equal((await j('/api/workspaces/switch', 'POST', { id: globexId }, carl)).status, 200);
assert.equal((await me(carl)).workspace.name, 'Globex');
assert.ok((await j('/api/conversations', 'GET', null, carl)).body.conversations.every(c => c.site_id === gSite.id));
assert.equal((await j('/api/workspaces/switch', 'POST', { id: 99999 }, carl)).status, 404);

// ---- removal, owner safety, key rotation, audit ----
assert.equal((await j('/api/members/' + uid('carl@acme.co'), 'DELETE', null, adam)).status, 200);
assert.equal((await me(carl)).workspace.name, 'Globex');
assert.equal((await j('/api/members/' + uid('adam@acme.co'), 'PUT', { role_id: rid('Owner') }, alice)).status, 200);
assert.equal((await j('/api/members/' + uid('adam@acme.co'), 'DELETE', null, alice)).status, 200, 'owner can remove another owner when one remains');
const rot = await j(`/api/sites/${s2.id}/rotate-key`, 'POST', null, alice);
assert.notEqual(rot.body.site.site_key, s2.site_key);
assert.equal((await j('/api/widget/init', 'POST', { key: s2.site_key, vid: 'visitorSHOP01' })).status, 403, 'old key revoked');
assert.equal((await j('/api/widget/init', 'POST', { key: rot.body.site.site_key, vid: 'visitorSHOP01' })).status, 200);
assert.equal((await j(`/api/sites/${aSite.id}`, 'DELETE', null, alice)).status, 200);
assert.equal((await j(`/api/sites/${s2.id}`, 'DELETE', null, alice)).status, 400, 'last site protected');
const log = (await j('/api/audit', 'GET', null, alice)).body.entries.map(e => e.action);
for (const a of ['member.added', 'member.updated', 'member.removed', 'role.created', 'role.updated', 'site.created', 'site.key_rotated', 'site.deleted', 'settings.updated']) assert.ok(log.includes(a), 'audit ' + a);
assert.equal((await j('/api/audit', 'GET', null, bob)).body.entries.some(e => ['site.key_rotated', 'role.created'].includes(e.action)), false, 'audit is per workspace');

carlLive.stop(); aliceLive.stop();
console.log('all rbac tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
