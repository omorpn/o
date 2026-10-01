// Billing: plan catalogue, checkout with Paystack / Flutterwave / Stripe (fakes), verification, signed webhooks,
// amount checks, idempotency, invoices, plan limits, renewals with saved cards, reminders, grace period, downgrade.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
process.env.DB_FILE = ':memory:';
process.env.SLA_CHECK_MS = '3600000';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_paystack';
process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST'; process.env.FLUTTERWAVE_WEBHOOK_HASH = 'flw-hash-123';
process.env.STRIPE_SECRET_KEY = 'sk_test_stripe'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

// ---------- fake payment providers ----------
const tx = new Map(); // reference → { amount (minor), currency, status }
let chargeResult = 'success', tamperAmount = false;
const fake = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const json = d => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  const u = new URL(req.url, 'http://x');
  if (!/Bearer (sk_test_paystack|FLWSECK_TEST|sk_test_stripe)/.test(req.headers.authorization || '')) { res.writeHead(401); return res.end('{"message":"bad key"}'); }
  // Paystack
  if (u.pathname === '/transaction/initialize') { const d = JSON.parse(b); tx.set(d.reference, { amount: d.amount, currency: d.currency, status: 'pending', email: d.email }); return json({ status: true, data: { authorization_url: 'https://checkout.paystack.test/' + d.reference, access_code: 'AC_' + d.reference } }); }
  if (u.pathname.startsWith('/transaction/verify/')) { const t = tx.get(decodeURIComponent(u.pathname.split('/').pop())) || {};
    return json({ status: true, data: { id: 991, status: t.status, amount: tamperAmount ? 100 : t.amount, currency: t.currency, customer: { email: t.email }, authorization: { authorization_code: 'AUTH_x1', reusable: true, last4: '4081', brand: 'visa', exp_month: '12', exp_year: '2030' } } }); }
  if (u.pathname === '/transaction/charge_authorization') { const d = JSON.parse(b); return json({ status: true, data: { id: 992, status: chargeResult, amount: d.amount, currency: d.currency, reference: d.reference } }); }
  // Flutterwave
  if (u.pathname === '/v3/payments') { const d = JSON.parse(b); tx.set(d.tx_ref, { amount: Math.round(d.amount * 100), currency: d.currency, status: 'pending' }); return json({ status: 'success', data: { link: 'https://checkout.flutterwave.test/' + d.tx_ref } }); }
  if (u.pathname === '/v3/transactions/verify_by_reference') { const t = tx.get(u.searchParams.get('tx_ref')) || {}; return json({ status: 'success', data: { id: 77, status: t.status === 'success' ? 'successful' : t.status, amount: t.amount / 100, currency: t.currency } }); }
  // Stripe
  if (u.pathname === '/v1/checkout/sessions' && req.method === 'POST') { const f = new URLSearchParams(b), ref = f.get('client_reference_id');
    tx.set('cs_' + ref, { amount: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), status: 'pending', ref }); return json({ id: 'cs_' + ref, url: 'https://checkout.stripe.test/cs_' + ref }); }
  if (u.pathname.startsWith('/v1/checkout/sessions/')) { const id = u.pathname.split('/').pop(), t = tx.get(id) || {}; return json({ id, payment_status: t.status === 'success' ? 'paid' : 'unpaid', status: 'open', amount_total: t.amount, currency: t.currency, payment_intent: 'pi_1' }); }
  res.writeHead(404); res.end('{}');
});
await new Promise(r => fake.listen(0, r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;
process.env.PAYSTACK_BASE_URL = process.env.FLUTTERWAVE_BASE_URL = process.env.STRIPE_BASE_URL = FAKE;

const { server } = await import('../server/index.js');
const { db } = await import('../server/core/db.js');
const { runBilling } = await import('../server/modules/billing/index.js');
await new Promise(r => server.listen(0, r));
const B = `http://localhost:${server.address().port}`;
const j = async (p, method = 'GET', body, cookie, headers = {}) => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...headers, ...(cookie && { cookie }) }, body: typeof body === 'string' ? body : body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers, text: r.status === 200 ? null : null };
};
const cookieOf = r => r.headers.get('set-cookie').split(';')[0];
const root = cookieOf(await j('/api/auth/login', 'POST', { email: 'admin@example.com', password: 'admin123' }));

// a customer workspace
const su = await j('/api/auth/signup', 'POST', { name: 'Ada', email: 'ada@shop.ng', password: 'password1', workspace: 'Ada Shop', elapsed: 9000 }, null, { 'User-Agent': 'Mozilla/5.0 Chrome/126' });
const ada = cookieOf(su), WS = (await j('/api/me', 'GET', null, ada)).body.workspace.id;
const roles = (await j('/api/roles', 'GET', null, ada)).body.roles;
await j('/api/members', 'POST', { name: 'Bo', email: 'bo@shop.ng', password: 'password1', role_id: roles.find(r => r.name === 'Agent').id }, ada);
const bo = cookieOf(await j('/api/auth/login', 'POST', { email: 'bo@shop.ng', password: 'password1' }));
const plan = () => db.prepare('SELECT plan FROM workspaces WHERE id=?').get(WS).plan;
const sub = () => db.prepare('SELECT * FROM subscriptions WHERE workspace_id=?').get(WS);

// ---------- overview & permissions ----------
assert.equal((await j('/api/billing', 'GET', null, bo)).status, 403, 'agents cannot see billing');
let ov = (await j('/api/billing', 'GET', null, ada)).body;
assert.equal(ov.plan, 'free'); assert.equal(ov.subscription, null);
assert.deepEqual(ov.providers.map(p => p.key).sort(), ['flutterwave', 'paystack', 'stripe']);
assert.deepEqual(ov.plans.find(p => p.plan === 'starter').prices.NGN, { month: 15000, year: 150000 });

// ---------- platform sets prices & limits ----------
assert.equal((await j('/api/platform/billing/plans/starter', 'PUT', { prices: {} }, ada)).status, 403);
await j('/api/platform/billing/plans/starter', 'PUT', { prices: { NGN: { month: 20000, year: 200000 }, USD: { month: 25, year: 250 } }, limits: { seats: 3, sites: 2 }, description: 'Small teams' }, root);
await j('/api/platform/billing/plans/free', 'PUT', { limits: { seats: 2, sites: 1 } }, root);
assert.equal((await j('/api/billing', 'GET', null, ada)).body.plans.find(p => p.plan === 'starter').prices.NGN.month, 20000);

// ---------- plan limits ----------
let r = await j('/api/members', 'POST', { name: 'Cy', email: 'cy@shop.ng', password: 'password1', role_id: roles.find(x => x.name === 'Agent').id }, ada);
assert.equal(r.status, 402); assert.match(r.body.error, /2 teammate seat/);
assert.equal((await j('/api/sites', 'POST', { name: 'Second shop' }, ada)).status, 402);

// ---------- checkout validation ----------
assert.equal((await j('/api/billing/checkout', 'POST', { plan: 'starter', provider: 'paystack', currency: 'NGN' }, bo)).status, 403);
assert.equal((await j('/api/billing/checkout', 'POST', { plan: 'nope', provider: 'paystack', currency: 'NGN' }, ada)).status, 400);
assert.equal((await j('/api/billing/checkout', 'POST', { plan: 'enterprise', provider: 'paystack', currency: 'NGN' }, ada)).status, 400, 'contact-sales plans have no online price');
assert.equal((await j('/api/billing/checkout', 'POST', { plan: 'starter', provider: 'stripe', currency: 'GHS' }, ada)).status, 400);

// ---------- Paystack: checkout → return → verify ----------
let co = (await j('/api/billing/checkout', 'POST', { plan: 'starter', provider: 'paystack', currency: 'NGN', interval: 'month' }, ada)).body;
assert.match(co.url, /^https:\/\/checkout\.paystack\.test\/chl_/); assert.equal(tx.get(co.reference).amount, 2_000_000, 'amount in kobo');
let v = (await j('/api/billing/verify', 'POST', { reference: co.reference }, ada)).body;
assert.equal(v.payment.status, 'pending'); assert.equal(plan(), 'free', 'nothing changes before the provider confirms');
tx.get(co.reference).status = 'success';
// a forged webhook is rejected; a correctly signed one triggers verification with the provider
const body = JSON.stringify({ event: 'charge.success', data: { reference: co.reference, amount: 1 } });
assert.equal((await j('/api/billing/webhook/paystack', 'POST', body, null, { 'x-paystack-signature': 'bad' })).status, 401);
assert.equal((await j('/api/billing/webhook/paystack', 'POST', body, null, { 'x-paystack-signature': createHmac('sha512', 'sk_test_paystack').update(body).digest('hex') })).status, 200);
assert.equal(plan(), 'starter'); assert.equal(sub().status, 'active'); assert.equal(JSON.parse(sub().authorization).last4, '4081', 'reusable card saved');
const end1 = sub().current_period_end; assert.ok(Math.abs(end1 - (Date.now() + 30 * 86400_000)) < 60_000);
v = (await j('/api/billing/verify', 'POST', { reference: co.reference }, ada)).body;
assert.equal(v.payment.status, 'paid'); assert.match(v.payment.invoice_no, /^INV-\d{4}-\d{5}$/); assert.equal(v.payment.display, '₦20,000');
assert.equal(sub().current_period_end, end1, 'verifying twice does not extend twice');
const inv = await fetch(`${B}/api/billing/invoices/${v.payment.id}`, { headers: { cookie: ada } });
assert.equal(inv.status, 200); assert.match(await inv.text(), /Invoice INV-[\s\S]*Ada Shop[\s\S]*₦20,000/);
assert.equal((await fetch(`${B}/api/billing/invoices/${v.payment.id}`, { headers: { cookie: root } })).status, 404, "other workspaces can't read invoices");
// limits follow the plan now
assert.equal((await j('/api/members', 'POST', { name: 'Cy', email: 'cy@shop.ng', password: 'password1', role_id: roles.find(x => x.name === 'Agent').id }, ada)).status, 200);

// ---------- amount mismatch is refused ----------
co = (await j('/api/billing/checkout', 'POST', { plan: 'pro', provider: 'paystack', currency: 'NGN' }, ada)).body;
tx.get(co.reference).status = 'success'; tamperAmount = true;
v = (await j('/api/billing/verify', 'POST', { reference: co.reference }, ada)).body;
assert.equal(v.payment.status, 'failed'); assert.match(v.payment.error, /Amount mismatch/); assert.equal(plan(), 'starter');
tamperAmount = false;

// ---------- Flutterwave (yearly, USD) ----------
co = (await j('/api/billing/checkout', 'POST', { plan: 'pro', provider: 'flutterwave', currency: 'USD', interval: 'year' }, ada)).body;
assert.match(co.url, /checkout\.flutterwave\.test/); tx.get(co.reference).status = 'success';
assert.equal((await j('/api/billing/webhook/flutterwave', 'POST', JSON.stringify({ data: { tx_ref: co.reference } }), null, { 'verif-hash': 'wrong' })).status, 401);
await j('/api/billing/webhook/flutterwave', 'POST', JSON.stringify({ data: { tx_ref: co.reference } }), null, { 'verif-hash': 'flw-hash-123' });
assert.equal(plan(), 'pro'); assert.equal(sub().interval, 'year'); assert.equal(sub().provider, 'flutterwave'); assert.equal(sub().authorization, null, 'card from another provider not reused');
assert.ok(sub().current_period_end > Date.now() + 360 * 86400_000);

// ---------- Stripe ----------
co = (await j('/api/billing/checkout', 'POST', { plan: 'starter', provider: 'stripe', currency: 'USD' }, ada)).body;
const sess = 'cs_' + co.reference; tx.get(sess).status = 'success';
const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: co.reference } } }), ts = Math.floor(Date.now() / 1000);
assert.equal((await j('/api/billing/webhook/stripe', 'POST', ev, null, { 'stripe-signature': `t=${ts},v1=00` })).status, 401);
await j('/api/billing/webhook/stripe', 'POST', ev, null, { 'stripe-signature': `t=${ts},v1=${createHmac('sha256', 'whsec_test').update(`${ts}.${ev}`).digest('hex')}` });
assert.equal(plan(), 'starter'); assert.equal(sub().currency, 'USD');
assert.equal(db.prepare("SELECT amount FROM payments WHERE reference=?").get(co.reference).amount, 2500);

// ---------- renewals ----------
// back on Paystack monthly with a saved card
co = (await j('/api/billing/checkout', 'POST', { plan: 'starter', provider: 'paystack', currency: 'NGN' }, ada)).body; tx.get(co.reference).status = 'success';
await j('/api/billing/verify', 'POST', { reference: co.reference }, ada);
const end = sub().current_period_end;
let out = await runBilling(end - 2 * 86400_000);
assert.equal(out.reminded, 1); assert.equal((await runBilling(end - 2 * 86400_000)).reminded, 0, 'one reminder per period');
assert.ok(db.prepare("SELECT 1 FROM notifications WHERE type='billing.status' AND title LIKE '%renews on%'").get());
out = await runBilling(end + 1000);
assert.equal(out.charged, 1, 'saved card charged automatically'); assert.equal(sub().status, 'active'); assert.ok(sub().current_period_end > end + 29 * 86400_000);
assert.equal(db.prepare("SELECT COUNT(*) n FROM payments WHERE kind='renewal' AND status='paid'").get().n, 1);
// failed renewal → past due → grace → downgrade
chargeResult = 'failed';
const end2 = sub().current_period_end;
out = await runBilling(end2 + 1000); assert.equal(out.pastDue, 1); assert.equal(sub().status, 'past_due'); assert.equal(plan(), 'starter', 'grace period keeps the plan');
out = await runBilling(end2 + 2 * 86400_000); assert.equal(out.downgraded, 0);
out = await runBilling(end2 + 4 * 86400_000); assert.equal(out.downgraded, 1); assert.equal(plan(), 'free'); assert.equal(sub().status, 'canceled');
chargeResult = 'success';

// ---------- cancel at period end / resume ----------
co = (await j('/api/billing/checkout', 'POST', { plan: 'pro', provider: 'paystack', currency: 'NGN' }, ada)).body; tx.get(co.reference).status = 'success';
await j('/api/billing/verify', 'POST', { reference: co.reference }, ada);
assert.equal(plan(), 'pro');
assert.equal((await j('/api/billing/cancel', 'POST', null, ada)).body.subscription.cancel_at_period_end, true);
assert.equal((await j('/api/billing/resume', 'POST', null, ada)).body.subscription.cancel_at_period_end, false);
await j('/api/billing/cancel', 'POST', null, ada);
out = await runBilling(sub().current_period_end + 1000);
assert.equal(out.downgraded, 1); assert.equal(out.charged, 0, 'canceled subscriptions are not charged'); assert.equal(plan(), 'free');

// ---------- platform revenue ----------
const pb = (await j('/api/platform/billing', 'GET', null, root)).body;
assert.ok(pb.revenue30.some(x => x.currency === 'NGN' && x.total >= 2_000_000)); assert.ok(pb.payments.length >= 6);
assert.equal((await j('/api/platform/billing', 'GET', null, ada)).status, 403);
assert.ok((await j('/api/audit', 'GET', null, ada)).body.entries.some(e => e.action === 'billing.checkout'));

fake.close();
console.log('all billing tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
