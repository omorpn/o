/**
 * Billing (core): plans bought online with Paystack, Flutterwave or Stripe. Each successful payment extends the
 * workspace's paid period for its plan (monthly or yearly). Paystack cards are charged again automatically at
 * renewal; otherwise owners get a reminder and renew in one click. Unpaid workspaces fall back to the free plan
 * after a 3-day grace period. Payments are confirmed by the provider (on return and by signed webhook) and checked
 * against the expected amount and currency before anything changes.
 */
import { randomBytes } from 'node:crypto';
import { db, now, getPlatform, setPlatform, once } from '../../core/db.js';
import { fail, str } from '../../core/http.js';
import { emit } from '../../core/events.js';
import { defineModule, planInfo, allModules, planAllows } from '../../core/modules.js';
import { membersWith, platformAudit } from '../../core/auth.js';
import { sendMail, mailConfigured } from '../../core/mail.js';
import { TYPES, notify } from '../notifications/index.js';
import { PROVIDERS, available, money, SYMBOL } from './providers.js';

db.exec(`
CREATE TABLE IF NOT EXISTS subscriptions (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, plan TEXT NOT NULL, status TEXT NOT NULL, interval TEXT NOT NULL,
  currency TEXT NOT NULL, provider TEXT NOT NULL, current_period_end INTEGER NOT NULL, cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  authorization TEXT, billing_email TEXT, reminded_for INTEGER, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, reference TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
  provider_ref TEXT, plan TEXT NOT NULL, interval TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  kind TEXT NOT NULL DEFAULT 'checkout', email TEXT, error TEXT, invoice_no TEXT, period_start INTEGER, period_end INTEGER, created_by INTEGER, created INTEGER NOT NULL, paid_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_payments_ws ON payments(workspace_id, id);
`);

const GRACE_MS = 3 * 86400_000, INTERVALS = { month: 30, year: 365 };
const plansList = () => getPlatform().plans.split(',').map(x => x.trim()).filter(Boolean);
const freePlan = () => plansList()[0] || 'free';
const subOf = ws => db.prepare('SELECT * FROM subscriptions WHERE workspace_id=?').get(ws);
const wsName = ws => db.prepare('SELECT name FROM workspaces WHERE id=?').get(ws)?.name || 'Workspace';
const billingContacts = ws => membersWith(ws, 'billing.manage').map(m => m.id);
const origin = c => (process.env.PUBLIC_URL || `${c.req.headers['x-forwarded-proto'] || 'http'}://${c.req.headers['x-forwarded-host'] || c.req.headers.host}`).replace(/\/$/, '');
/** Price in minor units, or null when the plan can't be bought in that currency/interval. */
const priceOf = (plan, currency, interval) => { const v = planInfo(plan).prices?.[currency]?.[interval]; return v > 0 ? Math.round(v * 100) : null; };

Object.assign(TYPES, { 'billing.status': { group: 'Workspace', label: 'Billing', description: 'Payments, renewals, failed charges and plan changes (billing managers)', in_app: 1, email: 1, push: 0 } });

function setPlan(ws, plan, reason) {
  const cur = db.prepare('SELECT plan FROM workspaces WHERE id=?').get(ws)?.plan; if (cur === plan) return;
  db.prepare('UPDATE workspaces SET plan=? WHERE id=?').run(plan, ws);
  emit('workspace.plan_changed', { ws, plan, reason });
}
function downgrade(ws, why) {
  const sub = subOf(ws); if (!sub) return;
  db.prepare("UPDATE subscriptions SET status='canceled', updated=? WHERE workspace_id=?").run(now(), ws);
  setPlan(ws, freePlan(), why);
  notify(billingContacts(ws), { type: 'billing.status', ws, link: 'settings/billing', skipOnline: false, title: `${wsName(ws)} is now on the ${freePlan()} plan`, body: why });
}

/** Applies a provider result to a pending payment exactly once. Returns the fresh payment row. */
export function completePayment(pay, result) {
  pay = db.prepare('SELECT * FROM payments WHERE id=?').get(pay.id);
  if (pay.status === 'paid' || !result) return pay;
  if (result.status === 'failed') { db.prepare("UPDATE payments SET status='failed', error=? WHERE id=?").run('Declined by the payment provider', pay.id); return db.prepare('SELECT * FROM payments WHERE id=?').get(pay.id); }
  if (result.status !== 'success') return pay;
  if (Number(result.amount) !== pay.amount || String(result.currency).toUpperCase() !== pay.currency) {
    db.prepare("UPDATE payments SET status='failed', error=? WHERE id=?").run(`Amount mismatch: expected ${money(pay.amount, pay.currency)}, provider reported ${result.amount} ${result.currency}`, pay.id);
    return db.prepare('SELECT * FROM payments WHERE id=?').get(pay.id);
  }
  const ws = pay.workspace_id, sub = subOf(ws), t = now();
  // renewing the same plan extends the current period; a new plan starts today
  const start = sub && sub.plan === pay.plan && sub.status !== 'canceled' && sub.current_period_end > t ? sub.current_period_end : t;
  const end = start + INTERVALS[pay.interval] * 86400_000;
  const invoice = `INV-${new Date(t).getFullYear()}-${String(pay.id).padStart(5, '0')}`;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE payments SET status='paid', paid_at=?, provider_ref=COALESCE(?,provider_ref), invoice_no=?, period_start=?, period_end=?, error=NULL WHERE id=?").run(t, result.providerRef || null, invoice, start, end, pay.id);
    const auth = result.authorization ? JSON.stringify(result.authorization) : (sub?.provider === pay.provider ? sub.authorization : null);
    db.prepare(`INSERT INTO subscriptions(workspace_id,plan,status,interval,currency,provider,current_period_end,cancel_at_period_end,authorization,billing_email,updated) VALUES(?,?,?,?,?,?,?,0,?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET plan=excluded.plan, status='active', interval=excluded.interval, currency=excluded.currency, provider=excluded.provider,
      current_period_end=excluded.current_period_end, cancel_at_period_end=0, authorization=excluded.authorization, billing_email=COALESCE(excluded.billing_email,billing_email), reminded_for=NULL, updated=excluded.updated`)
      .run(ws, pay.plan, 'active', pay.interval, pay.currency, pay.provider, end, auth, pay.email, t);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  setPlan(ws, pay.plan, 'payment');
  const paid = db.prepare('SELECT * FROM payments WHERE id=?').get(pay.id);
  emit('billing.paid', { ws, payment: paid });
  notify(billingContacts(ws), { type: 'billing.status', ws, link: 'settings/billing', title: `Payment received: ${money(pay.amount, pay.currency)}`, body: `${wsName(ws)} — ${pay.plan} plan, paid until ${new Date(end).toDateString()}. Invoice ${invoice}.` });
  if (pay.email && mailConfigured()) sendMail({ to: pay.email, subject: `Receipt ${invoice} — ${wsName(ws)}`, text: receiptText(paid) }).catch(e => console.error('receipt email:', e.message));
  return paid;
}
const receiptText = p => [`Thank you for your payment.`, '', `Invoice: ${p.invoice_no}`, `Workspace: ${wsName(p.workspace_id)}`, `Plan: ${p.plan} (${p.interval}ly)`, `Amount: ${money(p.amount, p.currency)}`,
  `Paid: ${new Date(p.paid_at).toUTCString()} via ${PROVIDERS[p.provider]?.label || p.provider}`, `Service period: ${new Date(p.period_start).toDateString()} – ${new Date(p.period_end).toDateString()}`, `Reference: ${p.reference}`].join('\n');

async function verifyPayment(pay) {
  const prov = PROVIDERS[pay.provider]; if (!prov?.configured()) return pay;
  try { return completePayment(pay, await prov.verify(pay)); } catch (e) { db.prepare('UPDATE payments SET error=? WHERE id=?').run(String(e.message).slice(0, 300), pay.id); return db.prepare('SELECT * FROM payments WHERE id=?').get(pay.id); }
}
const newRef = () => 'chl_' + randomBytes(10).toString('hex');

/** Renewals, reminders, grace periods and downgrades. Runs hourly; returns what it did (for tests). */
export async function runBilling(at = now()) {
  const out = { reminded: 0, charged: 0, pastDue: 0, downgraded: 0 };
  for (const s of db.prepare("SELECT * FROM subscriptions WHERE status IN ('active','past_due')").all()) {
    const ws = s.workspace_id;
    if (s.status === 'active' && !s.cancel_at_period_end && s.current_period_end > at && s.current_period_end - at < 3 * 86400_000 && s.reminded_for !== s.current_period_end) {
      db.prepare('UPDATE subscriptions SET reminded_for=? WHERE workspace_id=?').run(s.current_period_end, ws);
      notify(billingContacts(ws), { type: 'billing.status', ws, link: 'settings/billing', skipOnline: false, title: `Your ${s.plan} plan renews on ${new Date(s.current_period_end).toDateString()}`,
        body: s.authorization && s.provider === 'paystack' ? `We'll charge your saved ${JSON.parse(s.authorization).brand || 'card'} ending ${JSON.parse(s.authorization).last4}.` : 'Renew in Settings → Billing to keep your features.' });
      out.reminded++;
    }
    if (s.current_period_end > at) continue;
    if (s.cancel_at_period_end) { downgrade(ws, 'Your subscription ended as requested.'); out.downgraded++; continue; }
    const auth = s.authorization ? JSON.parse(s.authorization) : null, prov = PROVIDERS[s.provider], amount = priceOf(s.plan, s.currency, s.interval);
    if (s.status === 'active' && auth && prov?.charge && prov.configured() && amount) {
      const ref = newRef();
      const id = db.prepare('INSERT INTO payments(workspace_id,reference,provider,plan,interval,amount,currency,kind,email,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run(ws, ref, s.provider, s.plan, s.interval, amount, s.currency, 'renewal', auth.email || s.billing_email, at).lastInsertRowid;
      let r; try { r = await prov.charge({ authorization: auth, email: auth.email || s.billing_email, amount, currency: s.currency, reference: ref }); } catch (e) { r = { status: 'failed' }; db.prepare('UPDATE payments SET error=? WHERE id=?').run(String(e.message).slice(0, 300), id); }
      const p = completePayment({ id }, r);
      if (p.status === 'paid') { out.charged++; continue; }
    }
    if (s.status === 'active') {
      db.prepare("UPDATE subscriptions SET status='past_due', updated=? WHERE workspace_id=?").run(at, ws); out.pastDue++;
      notify(billingContacts(ws), { type: 'billing.status', ws, link: 'settings/billing', urgent: true, skipOnline: false, title: 'Payment needed to keep your plan', body: `Your ${s.plan} plan expired. Renew within 3 days to avoid moving to the ${freePlan()} plan.` });
    } else if (at - s.current_period_end > GRACE_MS) { downgrade(ws, 'The subscription was not renewed.'); out.downgraded++; }
  }
  // payments left pending (customer closed the tab): re-check for a day
  for (const p of db.prepare("SELECT * FROM payments WHERE status='pending' AND kind='checkout' AND created > ? AND created < ?").all(at - 86400_000, at - 10 * 60_000).slice(0, 20)) await verifyPayment(p);
  return out;
}

const payOut = p => ({ id: p.id, reference: p.reference, provider: p.provider, plan: p.plan, interval: p.interval, amount: p.amount, currency: p.currency, display: money(p.amount, p.currency), status: p.status, kind: p.kind,
  invoice_no: p.invoice_no, error: p.error, period_start: p.period_start, period_end: p.period_end, created: p.created, paid_at: p.paid_at });
const subOut = s => !s ? null : { plan: s.plan, status: s.status, interval: s.interval, currency: s.currency, provider: s.provider, provider_label: PROVIDERS[s.provider]?.label, current_period_end: s.current_period_end,
  cancel_at_period_end: !!s.cancel_at_period_end, card: s.authorization ? (({ brand, last4, exp }) => ({ brand, last4, exp }))(JSON.parse(s.authorization)) : null, billing_email: s.billing_email };
const catalog = () => { const mods = allModules().filter(m => !m.hidden && !m.core); return plansList().map(p => ({ plan: p, ...planInfo(p), modules: mods.filter(m => planAllows(p, m.key)).map(m => m.name) })); };

export default defineModule({
  key: 'billing', name: 'Billing', description: 'Plans, payments and invoices.', core: true, hidden: true,
  init() {
    once('billing-permission', () => {
      for (const r of db.prepare("SELECT id, permissions FROM roles WHERE system=0 AND name='Admin'").all()) {
        const p = JSON.parse(r.permissions); if (!p.includes('billing.manage')) db.prepare('UPDATE roles SET permissions=? WHERE id=?').run(JSON.stringify([...p, 'billing.manage']), r.id);
      }
    });
    setInterval(() => runBilling().catch(e => console.error('billing job:', e)), Number(process.env.BILLING_CHECK_MS) || 3600_000).unref();
  },
  routes: [
    { method: 'GET', path: '/api/billing', auth: 'user', handler: c => {
      if (!c.ws) fail(403, 'No workspace'); c.need('billing.manage');
      const ws = c.ws, w = db.prepare('SELECT plan FROM workspaces WHERE id=?').get(ws);
      return { plan: w.plan, subscription: subOut(subOf(ws)), plans: catalog(), providers: available(), symbols: SYMBOL,
        usage: { seats: db.prepare('SELECT COUNT(*) n FROM members WHERE workspace_id=?').get(ws).n, sites: db.prepare('SELECT COUNT(*) n FROM sites WHERE workspace_id=?').get(ws).n },
        payments: db.prepare('SELECT * FROM payments WHERE workspace_id=? ORDER BY id DESC LIMIT 50').all(ws).map(payOut) };
    } },
    { method: 'POST', path: '/api/billing/checkout', auth: 'user', handler: async c => {
      if (!c.ws) fail(403, 'No workspace'); c.need('billing.manage');
      const b = await c.body(), plan = str(b.plan, 30), interval = b.interval === 'year' ? 'year' : 'month', currency = str(b.currency, 3).toUpperCase(), prov = PROVIDERS[b.provider];
      if (!plansList().includes(plan)) fail(400, 'Unknown plan');
      if (!prov?.configured()) fail(400, 'That payment method is not available');
      if (!prov.currencies.includes(currency)) fail(400, `${prov.label} can't charge in ${currency}`);
      const amount = priceOf(plan, currency, interval); if (!amount) fail(400, `The ${plan} plan isn't sold online in ${currency} (${interval}ly) — contact sales`);
      const email = str(b.email, 200).toLowerCase() || c.me.email, reference = newRef();
      const id = db.prepare('INSERT INTO payments(workspace_id,reference,provider,plan,interval,amount,currency,email,created_by,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run(c.ws, reference, b.provider, plan, interval, amount, currency, email, c.me.id, now()).lastInsertRowid;
      try {
        const r = await prov.init({ reference, amount, currency, email, callbackUrl: `${origin(c)}/app/?billing=${reference}`, description: `${wsName(c.ws)} — ${plan} plan (${interval}ly)`, metadata: { workspace_id: c.ws, plan, interval } });
        db.prepare('UPDATE payments SET provider_ref=? WHERE id=?').run(r.providerRef || null, id);
        c.log('billing.checkout', `${plan} ${interval}ly ${money(amount, currency)} via ${prov.label}`);
        return { url: r.url, reference };
      } catch (e) { db.prepare("UPDATE payments SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 300), id); fail(502, `Could not start the payment: ${e.message}`); }
    } },
    { method: 'POST', path: '/api/billing/verify', auth: 'user', handler: async c => {
      const ref = str((await c.body()).reference, 60), pay = db.prepare('SELECT * FROM payments WHERE reference=?').get(ref);
      if (!pay || !c.auth.ws || pay.workspace_id !== c.ws) fail(404, 'Payment not found');
      const p = pay.status === 'pending' ? await verifyPayment(pay) : pay;
      return { payment: payOut(p), subscription: subOut(subOf(c.ws)), plan: db.prepare('SELECT plan FROM workspaces WHERE id=?').get(c.ws).plan };
    } },
    { method: 'POST', path: '/api/billing/:action', match: { action: /^(cancel|resume)$/ }, auth: 'user', handler: c => {
      if (!c.ws) fail(403, 'No workspace'); c.need('billing.manage');
      const s = subOf(c.ws); if (!s || !['active', 'past_due'].includes(s.status)) fail(400, 'There is no active subscription');
      db.prepare('UPDATE subscriptions SET cancel_at_period_end=?, updated=? WHERE workspace_id=?').run(c.params.action === 'cancel' ? 1 : 0, now(), c.ws);
      c.log('billing.' + c.params.action, s.plan); return { subscription: subOut(subOf(c.ws)) };
    } },
    { method: 'GET', path: '/api/billing/invoices/:id', auth: 'user', handler: c => {
      const p = db.prepare("SELECT * FROM payments WHERE id=? AND status='paid'").get(c.int('id'));
      if (!p || p.workspace_id !== c.ws) fail(404, 'Invoice not found'); c.need('billing.manage');
      const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
      c.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      c.res.end(`<!doctype html><meta charset="utf-8"><title>${esc(p.invoice_no)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#111}table{width:100%;border-collapse:collapse;margin:24px 0}td{padding:8px 0;border-bottom:1px solid #eee}td:last-child{text-align:right}h1{margin:0}.m{color:#666}</style>
<h1>Invoice ${esc(p.invoice_no)}</h1><p class="m">${esc(process.env.APP_NAME || 'Chatly')} · paid ${new Date(p.paid_at).toDateString()}</p><p><b>Billed to</b><br>${esc(wsName(p.workspace_id))}<br>${esc(p.email || '')}</p>
<table><tr><td>${esc(p.plan)} plan — ${p.interval}ly<br><span class="m">${new Date(p.period_start).toDateString()} – ${new Date(p.period_end).toDateString()}</span></td><td>${esc(money(p.amount, p.currency))}</td></tr>
<tr><td><b>Total paid</b></td><td><b>${esc(money(p.amount, p.currency))}</b></td></tr></table><p class="m">Paid via ${esc(PROVIDERS[p.provider]?.label || p.provider)} · reference ${esc(p.reference)}</p>`);
    } },
    { method: 'POST', path: '/api/billing/webhook/:provider', auth: 'public', handler: async c => {
      const prov = PROVIDERS[c.params.provider]; if (!prov) fail(404, 'Unknown provider');
      const raw = await c.raw(1_000_000);
      let ev; try { ev = prov.webhook(c.req.headers, raw); } catch { ev = null; }
      if (!ev) fail(401, 'Invalid signature');
      const pay = ev.reference && db.prepare('SELECT * FROM payments WHERE reference=?').get(ev.reference);
      if (pay && pay.status === 'pending') await verifyPayment(pay); // never trust the webhook body: ask the provider
      return { ok: true };
    } },
    // ----- platform operator -----
    { method: 'GET', path: '/api/platform/billing', auth: 'platform', handler: () => {
      const since = now() - 30 * 86400_000;
      return { plans: catalog(), providers: Object.entries(PROVIDERS).map(([key, p]) => ({ key, label: p.label, configured: p.configured() })),
        revenue30: db.prepare("SELECT currency, SUM(amount) total, COUNT(*) n FROM payments WHERE status='paid' AND paid_at>=? GROUP BY currency").all(since).map(r => ({ ...r, display: money(r.total, r.currency) })),
        subscriptions: db.prepare("SELECT status, COUNT(*) n FROM subscriptions GROUP BY status").all(),
        payments: db.prepare('SELECT p.*, w.name workspace FROM payments p JOIN workspaces w ON w.id=p.workspace_id ORDER BY p.id DESC LIMIT 100').all().map(p => ({ ...payOut(p), workspace: p.workspace })) };
    } },
    { method: 'PUT', path: '/api/platform/billing/plans/:plan', auth: 'platform', handler: async c => {
      const plan = c.params.plan; if (!plansList().includes(plan)) fail(404, 'Unknown plan');
      const b = await c.body(), cur = planInfo(plan), prices = {};
      for (const [cur3, v] of Object.entries(b.prices || cur.prices)) {
        if (!/^[A-Z]{3}$/.test(cur3)) fail(400, 'Bad currency');
        const m = Number(v?.month) || 0, y = Number(v?.year) || 0; if (m < 0 || y < 0 || m > 1e9 || y > 1e10) fail(400, 'Bad price');
        if (m || y) prices[cur3] = { month: m, year: y };
      }
      const limits = { seats: Math.max(0, Math.round(Number(b.limits?.seats ?? cur.limits.seats)) || 0), sites: Math.max(0, Math.round(Number(b.limits?.sites ?? cur.limits.sites)) || 0) };
      setPlatform({ planCatalog: { ...(getPlatform().planCatalog || {}), [plan]: { description: str(b.description ?? cur.description, 200), prices, limits } } });
      platformAudit(c.me, 'plan.pricing', `${plan}: ${JSON.stringify(prices)} seats=${limits.seats} sites=${limits.sites}`);
      return { plan: catalog().find(p => p.plan === plan) };
    } },
  ],
});
