/**
 * Payment providers behind one interface (no SDKs):
 *   init({ reference, amount (minor units), currency, email, callbackUrl, description, metadata }) → { url, providerRef }
 *   verify(payment) → { status: 'success'|'failed'|'pending', amount (minor), currency, providerRef, authorization? }
 *   webhook(headers, rawBody) → { reference } | null   (null = bad signature / irrelevant event)
 *   charge?({ authorization, email, amount, currency, reference }) → verify-like result (saved-card renewals)
 * Keys come from the environment; *_BASE_URL overrides exist for testing against fakes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const env = k => process.env[k] || '';
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
async function call(base, path, { method = 'GET', key, json, form, auth = 'Bearer' } = {}) {
  const r = await fetch(base.replace(/\/$/, '') + path, { method, signal: AbortSignal.timeout(20000),
    headers: { Authorization: `${auth} ${key}`, ...(json && { 'Content-Type': 'application/json' }), ...(form && { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    body: json ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || d.error?.message || `Payment provider error (HTTP ${r.status})`);
  return d;
}

export const PROVIDERS = {
  paystack: {
    label: 'Paystack', currencies: ['NGN', 'GHS', 'ZAR', 'KES', 'USD'], configured: () => !!env('PAYSTACK_SECRET_KEY'),
    base: () => env('PAYSTACK_BASE_URL') || 'https://api.paystack.co',
    async init(p) {
      const d = await call(this.base(), '/transaction/initialize', { method: 'POST', key: env('PAYSTACK_SECRET_KEY'),
        json: { email: p.email, amount: p.amount, currency: p.currency, reference: p.reference, callback_url: p.callbackUrl, metadata: p.metadata } });
      return { url: d.data.authorization_url, providerRef: d.data.access_code };
    },
    async verify(pay) {
      const d = (await call(this.base(), `/transaction/verify/${encodeURIComponent(pay.reference)}`, { key: env('PAYSTACK_SECRET_KEY') })).data || {};
      return { status: d.status === 'success' ? 'success' : ['failed', 'abandoned', 'reversed'].includes(d.status) ? 'failed' : 'pending', amount: d.amount, currency: d.currency,
        providerRef: String(d.id || ''), authorization: d.authorization?.reusable ? { code: d.authorization.authorization_code, last4: d.authorization.last4, brand: d.authorization.brand, exp: `${d.authorization.exp_month}/${d.authorization.exp_year}`, email: d.customer?.email } : null };
    },
    webhook(headers, raw) {
      const sig = headers['x-paystack-signature'], key = env('PAYSTACK_SECRET_KEY'); if (!sig || !key) return null;
      if (!safeEq(createHmac('sha512', key).update(raw).digest('hex'), sig)) return null;
      const e = JSON.parse(raw.toString()); return e.event === 'charge.success' ? { reference: e.data?.reference } : null;
    },
    async charge(p) {
      const d = (await call(this.base(), '/transaction/charge_authorization', { method: 'POST', key: env('PAYSTACK_SECRET_KEY'),
        json: { authorization_code: p.authorization.code, email: p.email, amount: p.amount, currency: p.currency, reference: p.reference } })).data || {};
      return { status: d.status === 'success' ? 'success' : d.status === 'failed' ? 'failed' : 'pending', amount: d.amount, currency: d.currency, providerRef: String(d.id || ''), authorization: p.authorization };
    },
  },
  flutterwave: {
    label: 'Flutterwave', currencies: ['NGN', 'GHS', 'KES', 'ZAR', 'USD', 'EUR', 'GBP'], configured: () => !!env('FLUTTERWAVE_SECRET_KEY'),
    base: () => env('FLUTTERWAVE_BASE_URL') || 'https://api.flutterwave.com',
    async init(p) {
      const d = await call(this.base(), '/v3/payments', { method: 'POST', key: env('FLUTTERWAVE_SECRET_KEY'),
        json: { tx_ref: p.reference, amount: p.amount / 100, currency: p.currency, redirect_url: p.callbackUrl, customer: { email: p.email }, customizations: { title: p.description }, meta: p.metadata } });
      return { url: d.data.link, providerRef: '' };
    },
    async verify(pay) {
      const d = (await call(this.base(), `/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(pay.reference)}`, { key: env('FLUTTERWAVE_SECRET_KEY') })).data || {};
      return { status: d.status === 'successful' ? 'success' : d.status === 'failed' ? 'failed' : 'pending', amount: Math.round(Number(d.amount) * 100), currency: d.currency, providerRef: String(d.id || '') };
    },
    webhook(headers, raw) {
      const h = env('FLUTTERWAVE_WEBHOOK_HASH'); if (!h || !headers['verif-hash'] || !safeEq(headers['verif-hash'], h)) return null;
      const e = JSON.parse(raw.toString()); return { reference: e.data?.tx_ref || e.txRef };
    },
  },
  stripe: {
    label: 'Stripe (cards worldwide)', currencies: ['USD', 'EUR', 'GBP', 'CAD', 'NGN'], configured: () => !!env('STRIPE_SECRET_KEY'),
    base: () => env('STRIPE_BASE_URL') || 'https://api.stripe.com',
    async init(p) {
      const d = await call(this.base(), '/v1/checkout/sessions', { method: 'POST', key: env('STRIPE_SECRET_KEY'), form: {
        mode: 'payment', client_reference_id: p.reference, customer_email: p.email, success_url: p.callbackUrl, cancel_url: p.callbackUrl,
        'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': p.currency.toLowerCase(), 'line_items[0][price_data][unit_amount]': String(p.amount),
        'line_items[0][price_data][product_data][name]': p.description, 'metadata[reference]': p.reference } });
      return { url: d.url, providerRef: d.id };
    },
    async verify(pay) {
      const d = await call(this.base(), `/v1/checkout/sessions/${encodeURIComponent(pay.provider_ref)}`, { key: env('STRIPE_SECRET_KEY') });
      return { status: d.payment_status === 'paid' ? 'success' : d.status === 'expired' ? 'failed' : 'pending', amount: d.amount_total, currency: String(d.currency || '').toUpperCase(), providerRef: d.payment_intent || d.id };
    },
    webhook(headers, raw) {
      const secret = env('STRIPE_WEBHOOK_SECRET'), sig = String(headers['stripe-signature'] || ''); if (!secret || !sig) return null;
      const parts = Object.fromEntries(sig.split(',').map(x => x.split('='))), t = Number(parts.t);
      if (!t || Math.abs(Date.now() / 1000 - t) > 600) return null;
      if (!safeEq(createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'), parts.v1 || '')) return null;
      const e = JSON.parse(raw.toString()); return e.type === 'checkout.session.completed' ? { reference: e.data?.object?.client_reference_id } : null;
    },
  },
};
export const available = () => Object.entries(PROVIDERS).filter(([, p]) => p.configured()).map(([key, p]) => ({ key, label: p.label, currencies: p.currencies }));
export const SYMBOL = { NGN: '₦', USD: '$', EUR: '€', GBP: '£', GHS: 'GH₵', KES: 'KSh', ZAR: 'R', CAD: 'CA$' };
export const money = (minor, cur) => `${SYMBOL[cur] || cur + ' '}${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
