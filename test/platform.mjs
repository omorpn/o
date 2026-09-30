// Platform operator console: super-admin access, suspension, plans, user management, sign-up control.
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
const cookieOf = r => r.headers.get('set-cookie')?.split(';')[0];
const login = async (email, password) => cookieOf(await j('/api/auth/login', 'POST', { email, password }));

const root = await login('admin@example.com', 'admin123');
const rootMe = (await j('/api/me', 'GET', null, root)).body;
assert.equal(rootMe.user.platform_role, 'superadmin', 'first account is the platform admin');

const su = await j('/api/auth/signup', 'POST', { name: 'Tina', email: 'tina@shop.co', password: 'password1', workspace: 'Tina Shop' });
const tina = cookieOf(su);
const tMe = (await j('/api/me', 'GET', null, tina)).body;
assert.equal(tMe.user.platform_role, null);
assert.equal((await j('/api/platform/overview', 'GET', null, tina)).status, 403, 'customers cannot reach the platform console');
assert.equal((await j('/api/platform/workspaces', 'GET', null, tina)).status, 403);

// overview & listing
const ov = (await j('/api/platform/overview', 'GET', null, root)).body;
assert.equal(ov.workspaces, 2); assert.equal(ov.users, 2); assert.equal(ov.signups.length, 14); assert.equal(ov.signups.at(-1).workspaces, 2);
const list = (await j('/api/platform/workspaces?q=tina@shop', 'GET', null, root)).body.workspaces;
assert.equal(list.length, 1); assert.equal(list[0].owner.email, 'tina@shop.co'); assert.equal(list[0].plan, 'free');
const wsId = list[0].id;
const detail = (await j('/api/platform/workspaces/' + wsId, 'GET', null, root)).body;
assert.equal(detail.members[0].role, 'Owner'); assert.equal(detail.sites.length, 1);

// plans
assert.equal((await j('/api/platform/workspaces/' + wsId, 'PUT', { plan: 'gold' }, root)).status, 400);
assert.equal((await j('/api/platform/workspaces/' + wsId, 'PUT', { plan: 'pro' }, root)).body.workspace.plan, 'pro');
assert.equal((await j('/api/me', 'GET', null, tina)).body.workspace.plan, 'pro');

// suspension blocks dashboard, widget and live connections
const key = tMe.sites[0].site_key;
assert.equal((await j('/api/widget/init', 'POST', { key, vid: 'visitorTINA01' })).status, 200);
const ac = new AbortController(); let streamEnded = false;
fetch(B + '/api/events', { headers: { cookie: tina }, signal: ac.signal }).then(async r => { for await (const _ of r.body); streamEnded = true; }).catch(() => {});
await sleep(200);
assert.equal((await j('/api/platform/workspaces/' + wsId, 'PUT', { suspended: true, reason: 'Unpaid invoice' }, root)).status, 200);
await sleep(200);
assert.ok(streamEnded, 'live connection closed on suspension');
const blocked = await j('/api/conversations', 'GET', null, tina);
assert.equal(blocked.status, 403); assert.match(blocked.body.error, /suspended: Unpaid invoice/);
assert.equal((await j('/api/me', 'GET', null, tina)).body.workspace.suspended, 'Unpaid invoice', 'dashboard can show the reason');
assert.match((await j('/api/widget/init', 'POST', { key, vid: 'visitorTINA01' })).body.error, /unavailable/);
assert.equal((await j('/api/platform/workspaces/' + wsId, 'PUT', { suspended: false }, root)).status, 200);
assert.equal((await j('/api/conversations', 'GET', null, tina)).status, 200, 'reactivated');
assert.equal((await j('/api/widget/init', 'POST', { key, vid: 'visitorTINA01' })).status, 200);
assert.ok((await j('/api/audit', 'GET', null, tina)).body.entries.some(e => e.action === 'workspace.suspended'), 'customer sees suspension in their audit log');

// user management
const users = (await j('/api/platform/users?q=tina', 'GET', null, root)).body.users;
const tinaId = users[0].id; assert.equal(users[0].memberships[0].name, 'Tina Shop');
assert.equal((await j('/api/platform/users/' + tinaId, 'PUT', { disabled: true }, root)).status, 200);
assert.equal((await j('/api/me', 'GET', null, tina)).status, 401, 'disabled user signed out');
assert.equal((await j('/api/auth/login', 'POST', { email: 'tina@shop.co', password: 'password1' })).status, 403);
assert.equal((await j('/api/platform/users/' + tinaId, 'PUT', { disabled: false }, root)).status, 200);
const reset = (await j(`/api/platform/users/${tinaId}/reset-password`, 'POST', null, root)).body;
assert.ok(reset.temporaryPassword && !reset.emailed);
assert.equal((await j('/api/auth/login', 'POST', { email: 'tina@shop.co', password: 'password1' })).status, 401, 'old password gone');
const tina2 = await login('tina@shop.co', reset.temporaryPassword);
assert.ok(tina2, 'temporary password works');

// platform admins
const rootId = rootMe.user.id;
assert.equal((await j('/api/platform/users/' + rootId, 'PUT', { platform_role: null }, root)).status, 400, 'cannot demote yourself');
assert.equal((await j('/api/platform/users/' + rootId, 'PUT', { disabled: true }, root)).status, 400);
assert.equal((await j('/api/platform/users/' + tinaId, 'PUT', { platform_role: 'superadmin' }, root)).status, 200);
assert.equal((await j('/api/platform/overview', 'GET', null, tina2)).status, 200, 'promoted');
assert.equal((await j('/api/platform/users/' + tinaId, 'PUT', { platform_role: null }, root)).status, 200);
assert.equal((await j('/api/platform/overview', 'GET', null, tina2)).status, 403, 'demoted');

// platform settings: sign-up switch + announcement
assert.equal((await j('/api/platform/settings', 'PUT', { allowSignup: false, announcement: 'Maintenance Sunday 02:00 UTC', plans: 'free, pro, Enterprise' }, root)).status, 200);
assert.equal((await j('/api/public/config')).body.signupEnabled, false);
assert.equal((await j('/api/auth/signup', 'POST', { name: 'N', email: 'n@n.co', password: 'password1' })).status, 403);
assert.equal((await j('/api/me', 'GET', null, tina2)).body.announcement, 'Maintenance Sunday 02:00 UTC');
assert.equal((await j('/api/platform/workspaces/' + wsId, 'PUT', { plan: 'enterprise' }, root)).status, 200, 'custom plan list');
await j('/api/platform/settings', 'PUT', { allowSignup: true }, root);
assert.equal((await j('/api/auth/signup', 'POST', { name: 'N', email: 'n@n.co', password: 'password1' })).status, 200);

// deleting a workspace
assert.equal((await j('/api/platform/workspaces/' + wsId, 'DELETE', { confirm: 'wrong' }, root)).status, 400);
assert.equal((await j('/api/platform/workspaces/' + wsId, 'DELETE', { confirm: 'Tina Shop' }, root)).status, 200);
assert.equal((await j('/api/me', 'GET', null, tina2)).body.workspace, null, 'member left without a workspace');
assert.equal((await j('/api/widget/init', 'POST', { key, vid: 'visitorTINA01' })).status, 403, 'widget of deleted workspace is gone');

const pa = (await j('/api/platform/audit', 'GET', null, root)).body.entries.map(e => e.action);
for (const a of ['workspace.updated', 'workspace.deleted', 'user.updated', 'user.password_reset', 'platform.settings']) assert.ok(pa.includes(a), 'platform audit ' + a);

ac.abort();
console.log('all platform tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
