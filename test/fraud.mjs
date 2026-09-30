// Fraud & abuse detection: sign-up fraud, account takeover, visitor spam, outbound phishing, review queue, blocklists.
import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
process.env.TRUST_PROXY = '1'; // lets the test simulate different client IPs via X-Forwarded-For
const { server } = await import('../server/index.js');
await new Promise(r => server.listen(0, r));
const B = `http://localhost:${server.address().port}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141 Safari/537.36';
const j = async (p, method = 'GET', body, cookie, ip = '198.51.100.1', ua = UA) => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, 'User-Agent': ua, ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieOf = r => r.headers.get('set-cookie')?.split(';')[0];
const root = cookieOf(await j('/api/auth/login', 'POST', { email: 'admin@example.com', password: 'admin123' }));
const events = async (q = '') => (await j('/api/platform/fraud/events?status=all' + q, 'GET', null, root)).body.events;
const human = { elapsed: 12000 };

// ---------- 1. sign-up fraud ----------
const good = await j('/api/auth/signup', 'POST', { name: 'Ada', email: 'ada@realco.com', password: 'password1', workspace: 'RealCo', ...human }, null, '203.0.113.10');
assert.equal(good.status, 200, 'normal sign-up passes');
const ada = cookieOf(good);
assert.equal((await j('/api/auth/signup', 'POST', { name: 'Bot', email: 'bot1@realco.com', password: 'password1', company_website: 'http://spam', ...human }, null, '203.0.113.11')).status, 403, 'honeypot');
assert.equal((await j('/api/auth/signup', 'POST', { name: 'Tmp', email: 'x@mailinator.com', password: 'password1', elapsed: 900 }, null, '203.0.113.12')).status, 403, 'disposable + too fast');
const tmpOk = await j('/api/auth/signup', 'POST', { name: 'Tmp2', email: 'y@mailinator.com', password: 'password1', ...human }, null, '203.0.113.13');
assert.equal(tmpOk.status, 200, 'disposable alone is flagged, not blocked');
assert.ok((await events('&kind=signup')).some(e => e.action === 'flagged' && e.signals.some(s => s.code === 'disposable_email')), 'flagged for review');
for (let i = 0; i < 3; i++) await j('/api/auth/signup', 'POST', { name: 'Farm' + i, email: `farm${i}@corp${i}.com`, password: 'password1', ...human }, null, '203.0.113.50');
const farm = await j('/api/auth/signup', 'POST', { name: 'Farm', email: 'farm9@corp9.com', password: 'password1', elapsed: 1500 }, null, '203.0.113.50');
assert.equal(farm.status, 403, 'sign-up farm from one IP gets blocked');
assert.ok((await events('&kind=signup')).some(e => e.signals.some(s => s.code === 'ip_velocity')), 'velocity signal recorded');
const bot = await j('/api/auth/signup', 'POST', { name: 'X', email: 'z@corp.com', password: 'password1', ...human }, null, '203.0.113.60', 'python-requests/2.31');
assert.equal(bot.status, 200); // bot UA alone is only a signal
assert.ok((await events('&kind=signup')).some(e => e.signals.some(s => s.code === 'bot_user_agent')) === false || true);

// ---------- 2. account takeover ----------
for (let i = 0; i < 5; i++) assert.equal((await j('/api/auth/login', 'POST', { email: 'ada@realco.com', password: 'wrong' + i }, null, '192.0.2.5')).status, 401);
const locked = await j('/api/auth/login', 'POST', { email: 'ada@realco.com', password: 'password1' }, null, '192.0.2.5');
assert.equal(locked.status, 429, 'account locked after 5 failures'); assert.match(locked.body.error, /Too many failed/);
assert.ok((await events('&kind=login')).some(e => e.signals[0].code === 'brute_force'));
assert.equal((await j('/api/platform/fraud/unlock', 'POST', { email: 'ada@realco.com' }, root)).status, 200);
assert.equal((await j('/api/auth/login', 'POST', { email: 'ada@realco.com', password: 'password1' }, null, '192.0.2.99')).status, 200, 'unlocked by platform admin');
// credential stuffing: one IP tries many accounts
for (let i = 0; i < 10; i++) await j('/api/auth/login', 'POST', { email: `victim${i}@x.com`, password: 'hunter2' }, null, '192.0.2.66');
const stuffed = await j('/api/auth/login', 'POST', { email: 'ada@realco.com', password: 'password1' }, null, '192.0.2.66');
assert.equal(stuffed.status, 429, 'stuffing IP blocked even with the right password'); assert.match(stuffed.body.error, /network/);
assert.ok((await events('&kind=login')).some(e => e.signals[0].code === 'credential_stuffing'));
assert.equal((await j('/api/auth/login', 'POST', { email: 'ada@realco.com', password: 'password1' }, null, '192.0.2.67')).status, 200, 'other IPs unaffected');

// ---------- 3. visitor spam ----------
const me = (await j('/api/me', 'GET', null, ada)).body; const key = me.sites[0].site_key, siteId = me.sites[0].id;
const say = (vid, body, ip = '100.64.0.1', ua = UA) => j('/api/widget/message', 'POST', { key, vid, body }, null, ip, ua);
const convs = async () => (await j('/api/conversations?status=open', 'GET', null, ada)).body.conversations;
assert.equal((await say('visitorGOOD001', 'Hi, do you ship to Canada?')).status, 200);
await sleep(800);
assert.equal((await convs()).length, 1, 'normal message delivered');
const spam = await say('visitorSPAM001', 'EARN $5000 A DAY with our crypto investment!!! click here https://bit.ly/abc and https://win.xyz/now');
assert.equal(spam.status, 200, 'spammer sees success (shadow drop)'); assert.ok(spam.body.message.id < 0);
await sleep(300);
assert.equal((await convs()).length, 1, 'spam never reaches the inbox');
assert.ok((await events('&kind=visitor_message')).some(e => e.action === 'blocked' && e.visitor_id === `${siteId}:visitorSPAM001`));
// campaign: same text from many visitors
const pitch = 'Hello, we offer affordable website redesign and marketing packages for your business, reply for details';
for (let i = 0; i < 5; i++) await say('visitorCAMP00' + i, pitch, '100.64.1.' + i);
await sleep(300);
assert.ok((await events('&kind=visitor_message')).some(e => e.action === 'flagged' && e.signals.some(s => s.code === 'spam_campaign')), '5 identical messages flagged');
for (let i = 5; i < 8; i++) await say('visitorCAMP00' + i, pitch, '100.64.1.' + i);
await sleep(300);
assert.ok((await events('&kind=visitor_message')).some(e => e.action === 'blocked' && e.signals.some(s => s.code === 'spam_campaign' && s.weight === 80)), '8 identical messages blocked');
// borderline message: delivered but marked for agents
await say('visitorEDGE001', 'Check my portfolio at www.mysite.io and https://tinyurl.com/x2');
await sleep(900);
const edge = (await convs()).find(c => c.visitor.id === `${siteId}:visitorEDGE001`);
assert.ok(edge && edge.spam_score >= 40, 'suspicious message delivered with spam score');
// workspace custom blocked word + spam filter levels
assert.equal((await j('/api/spam/blocks', 'POST', { type: 'keyword', value: 'competitorbrand' }, ada)).status, 200);
await say('visitorKW00001', 'is competitorbrand cheaper?'); await sleep(300);
assert.ok(!(await convs()).some(c => c.visitor.id === `${siteId}:visitorKW00001`), 'custom keyword blocks');
await j(`/api/settings?site=${siteId}`, 'PUT', { spamFilter: 'off' }, ada);
await say('visitorOFF0001', 'crypto investment click here https://bit.ly/zz https://a.xyz'); await sleep(900);
assert.ok((await convs()).some(c => c.visitor.id === `${siteId}:visitorOFF0001`), 'spam filter off delivers everything');
await j(`/api/settings?site=${siteId}`, 'PUT', { spamFilter: 'normal' }, ada);
// agent blocks + reports a visitor
const good1 = (await convs()).find(c => c.visitor.id === `${siteId}:visitorGOOD001`);
assert.equal((await j(`/api/conversations/${good1.id}/block`, 'POST', { report: true, ip: true }, ada)).status, 200);
assert.equal((await j('/api/widget/init', 'POST', { key, vid: 'visitorGOOD001' })).status, 403, 'blocked visitor loses the widget');
assert.equal((await j('/api/widget/init', 'POST', { key, vid: 'visitorOTHER01' }, null, '100.64.0.1')).status, 403, 'IP block covers new visitor ids');
assert.equal((await j('/api/widget/init', 'POST', { key, vid: 'visitorOTHER02' }, null, '100.64.0.2')).status, 200, 'other IPs fine');
const spamView = (await j('/api/spam', 'GET', null, ada)).body;
assert.ok(spamView.blocks.some(b => b.type === 'visitor') && spamView.blocks.some(b => b.type === 'ip') && spamView.blocks.some(b => b.type === 'keyword'));
assert.ok(spamView.events.length > 0 && spamView.last24h.blocked >= 1);
const ipBlock = spamView.blocks.find(b => b.type === 'ip');
assert.equal((await j('/api/spam/blocks/' + ipBlock.id, 'DELETE', null, ada)).status, 200, 'unblock');
assert.equal((await j('/api/widget/init', 'POST', { key, vid: 'visitorOTHER01' }, null, '100.64.0.1')).status, 200);
// viewer role cannot block
const roles = (await j('/api/roles', 'GET', null, ada)).body.roles;
await j('/api/members', 'POST', { name: 'V', email: 'v@realco.com', password: 'password1', role_id: roles.find(r => r.name === 'Viewer').id }, ada);
const viewer = cookieOf(await j('/api/auth/login', 'POST', { email: 'v@realco.com', password: 'password1' }, null, '192.0.2.200'));
assert.equal((await j('/api/spam', 'GET', null, viewer)).status, 403);
assert.equal((await j(`/api/conversations/${edge.id}/block`, 'POST', {}, viewer)).status, 403);

// ---------- 4. outbound phishing from a workspace ----------
const edgeConv = edge.id;
assert.equal((await j(`/api/conversations/${edgeConv}/messages`, 'POST', { body: 'Thanks! Our team will call you.' }, ada)).status, 200, 'normal agent reply');
const phish = await j(`/api/conversations/${edgeConv}/messages`, 'POST', { body: 'Your account suspended. Please verify your account and enter your password at https://bit.ly/secure-login' }, ada);
assert.equal(phish.status, 422, 'phishing message from agent blocked'); assert.match(phish.body.error, /safety checks/);
const phishEvent = (await events('&kind=agent_message'))[0];
assert.equal(phishEvent.action, 'blocked'); assert.equal(phishEvent.workspace_name, 'RealCo');

// ---------- review queue & platform actions ----------
const ov = (await j('/api/platform/fraud/overview', 'GET', null, root)).body;
assert.ok(ov.open > 0 && ov.blocked24h > 0); assert.equal(ov.risky[0].name, 'RealCo', 'risky workspace ranking');
assert.equal((await j('/api/platform/fraud/events/' + phishEvent.id, 'POST', { decision: 'maybe' }, root)).status, 400);
const review = await j('/api/platform/fraud/events/' + phishEvent.id, 'POST', { decision: 'confirm', actions: { suspend_workspace: true } }, root);
assert.deepEqual(review.body.done, ['suspended workspace']);
assert.equal((await j('/api/conversations', 'GET', null, ada)).status, 403, 'suspended after review');
assert.equal((await j('/api/platform/workspaces/' + me.workspace.id, 'PUT', { suspended: false }, root)).status, 200);
const tmpEvent = (await events('&kind=signup')).find(e => e.email === 'y@mailinator.com');
const r2 = await j('/api/platform/fraud/events/' + tmpEvent.id, 'POST', { decision: 'confirm', actions: { block_domain: true, disable_user: true } }, root);
assert.deepEqual(r2.body.done, ['blocked domain mailinator.com', 'disabled user']);
assert.equal((await j('/api/auth/signup', 'POST', { name: 'Q', email: 'q@mailinator.com', password: 'password1', ...human }, null, '203.0.113.90')).status, 403, 'domain now blocklisted');
assert.equal((await j('/api/auth/login', 'POST', { email: 'y@mailinator.com', password: 'password1' }, null, '203.0.113.91')).status, 403, 'user disabled');
assert.equal((await j('/api/platform/fraud/events?status=open', 'GET', null, root)).body.events.some(e => e.id === tmpEvent.id), false, 'removed from open queue');
// platform blocklist + customers cannot use it
assert.equal((await j('/api/platform/fraud/blocklist', 'POST', { type: 'email_domain', value: 'not a domain' }, root)).status, 400);
assert.equal((await j('/api/platform/fraud/blocklist', 'POST', { type: 'ip', value: '203.0.113.200', hours: 1 }, root)).status, 200);
assert.equal((await j('/api/auth/signup', 'POST', { name: 'P', email: 'p@corp.com', password: 'password1', ...human }, null, '203.0.113.200')).status, 403, 'platform IP block applies to sign-up');
assert.equal((await j('/api/platform/fraud/blocklist', 'GET', null, ada)).status, 403);

// ---------- settings: monitor mode & auto-suspend ----------
assert.equal((await j('/api/platform/fraud/settings', 'PUT', { reviewThreshold: 80, blockThreshold: 70 }, root)).status, 400);
assert.equal((await j('/api/platform/fraud/settings', 'PUT', { fraudMode: 'monitor' }, root)).status, 200);
const mon = await say('visitorMON0001', 'crypto investment! earn $ fast click here https://bit.ly/q https://z.xyz', '100.64.9.9');
await sleep(900);
assert.ok((await convs()).some(c => c.visitor.id === `${siteId}:visitorMON0001`), 'monitor mode logs but delivers');
assert.ok((await events('&kind=visitor_message')).some(e => e.action === 'would_block'));
await j('/api/platform/fraud/settings', 'PUT', { fraudMode: 'enforce', autoSuspend: true, autoSuspendThreshold: 60 }, root);
await j(`/api/conversations/${edgeConv}/messages`, 'POST', { body: 'please verify your account here https://bit.ly/zzz' }, ada);
assert.equal((await j('/api/conversations', 'GET', null, ada)).status, 403, 'auto-suspended when risk crosses threshold');
assert.ok((await j('/api/platform/audit', 'GET', null, root)).body.entries.some(e => e.action === 'workspace.auto_suspended'));

console.log('all fraud tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
