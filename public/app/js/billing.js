// Settings → Billing (workspace) and Platform → Billing (operator): plans, checkout, subscription, invoices, pricing.
import { S, api, appendTo, guard, h, toast } from './core.js';
import { renderShell } from './shell.js';

let currency = null, interval = 'month';
const STATUS = { active: ['Active', 'ok'], past_due: ['Payment due', 'bad'], canceled: ['Ended', ''] };
const fmt = (v, cur, sym) => `${sym[cur] || cur + ' '}${Number(v).toLocaleString('en-US')}`;
const date = t => new Date(t).toLocaleDateString([], { dateStyle: 'medium' });

export async function renderBilling(page) {
  const d = await api('/billing');
  const currencies = [...new Set(d.plans.flatMap(p => Object.keys(p.prices || {})))].filter(c => d.providers.some(p => p.currencies.includes(c)));
  if (!currency || !currencies.includes(currency)) currency = currencies.includes('NGN') ? 'NGN' : currencies[0] || 'USD';
  const provs = d.providers.filter(p => p.currencies.includes(currency));
  const provSel = h('select', { style: 'width:auto' }, ...provs.map(p => h('option', { value: p.key }, p.label)));
  const s = d.subscription, cur = d.plans.find(p => p.plan === d.plan);
  const lim = (n, max, label) => h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', {}, label), h('b', {}, max ? `${n} / ${max}` : `${n} (unlimited)`));
  const buy = plan => guard(async () => {
    if (!provs.length) throw new Error('Online payment is not set up on this server yet — contact the platform owner.');
    const r = await api('/billing/checkout', 'POST', { plan, interval, currency, provider: provSel.value });
    toast('Redirecting to secure checkout…'); location.href = r.url;
  });

  appendTo(page,
    h('div', { class: 'grid2', style: 'align-items:start' },
      h('div', { class: 'card' }, h('h3', {}, 'Current plan'),
        h('div', { class: 'row' }, h('span', { style: 'font-size:22px;font-weight:700;text-transform:capitalize' }, d.plan), s && s.plan === d.plan ? h('span', { class: 'pill ' + STATUS[s.status][1] }, STATUS[s.status][0]) : null),
        cur?.description ? h('p', { class: 'hint' }, cur.description) : null,
        s && s.status !== 'canceled' ? [
          h('p', {}, s.cancel_at_period_end ? `Ends on ${date(s.current_period_end)} — you'll move to the free plan.` : s.status === 'past_due' ? `Expired on ${date(s.current_period_end)}. Renew within 3 days to keep your features.` : `Renews on ${date(s.current_period_end)} (${s.interval}ly, ${s.currency}).`),
          s.card ? h('p', { class: 'hint' }, `Saved card: ${s.card.brand || 'card'} •••• ${s.card.last4} (exp ${s.card.exp}) via ${s.provider_label} — renewals are charged automatically.`) : h('p', { class: 'hint' }, `Paid via ${s.provider_label}. You'll get a reminder before it ends.`),
          h('div', { class: 'row' }, s.status === 'past_due' ? h('button', { class: 'btn', onclick: () => { interval = s.interval; currency = s.currency; buy(s.plan)(); } }, 'Renew now') : null,
            s.cancel_at_period_end ? h('button', { class: 'btn sec', onclick: guard(async () => { await api('/billing/resume', 'POST'); toast('Subscription resumed'); renderShell(); }) }, 'Keep my subscription')
              : h('button', { class: 'btn sec', onclick: guard(async () => { if (!confirm(`Cancel? You keep the ${s.plan} plan until ${date(s.current_period_end)}.`)) return; await api('/billing/cancel', 'POST'); toast('Subscription will end at the period end'); renderShell(); }) }, 'Cancel subscription'))]
          : h('p', { class: 'hint' }, 'No paid subscription.')),
      h('div', { class: 'card' }, h('h3', {}, 'Usage'), lim(d.usage.seats, cur?.limits.seats, 'Teammates'), lim(d.usage.sites, cur?.limits.sites, 'Websites'),
        h('p', { class: 'hint', style: 'margin-top:12px' }, 'Need more? Pick a bigger plan below.'))),
    h('div', { class: 'row', style: 'margin:18px 0 10px' }, h('h3', { class: 'grow', style: 'margin:0' }, 'Plans'),
      currencies.length > 1 ? h('div', { class: 'filters', style: 'margin:0' }, ...currencies.map(c => h('button', { class: currency === c ? 'on' : '', onclick: () => { currency = c; renderShell(); } }, c))) : null,
      h('div', { class: 'filters', style: 'margin:0' }, h('button', { class: interval === 'month' ? 'on' : '', onclick: () => { interval = 'month'; renderShell(); } }, 'Monthly'), h('button', { class: interval === 'year' ? 'on' : '', onclick: () => { interval = 'year'; renderShell(); } }, 'Yearly')),
      provs.length > 1 ? provSel : provs.length ? h('span', { class: 'hint', style: 'margin:0' }, 'Pay with ' + provs[0].label) : null),
    h('div', { class: 'plans' }, ...d.plans.map(p => {
      const price = p.prices?.[currency]?.[interval], isCur = p.plan === d.plan, monthly = p.prices?.[currency]?.month;
      return h('div', { class: 'card plan' + (isCur ? ' current' : '') },
        h('div', { class: 'row' }, h('b', { class: 'grow', style: 'text-transform:capitalize;font-size:17px' }, p.plan), isCur ? h('span', { class: 'pill ok' }, 'current') : null),
        h('div', { class: 'price' }, price ? [fmt(price, currency, d.symbols), h('small', {}, interval === 'year' ? ' / year' : ' / month')] : Object.keys(p.prices || {}).length ? `Not sold in ${currency}` : p.plan === d.plans[0].plan ? 'Free' : 'Contact sales'),
        interval === 'year' && price && monthly ? h('div', { class: 'hint', style: 'margin:0' }, `${Math.round((1 - price / (monthly * 12)) * 100)}% less than monthly`) : null,
        h('p', { class: 'hint' }, p.description), h('div', { class: 'hint', style: 'margin:0 0 6px' }, `${p.limits.seats || 'Unlimited'} teammates · ${p.limits.sites || 'unlimited'} websites`),
        h('ul', { class: 'feat' }, ...p.modules.slice(0, 12).map(m => h('li', {}, m))),
        price ? h('button', { class: 'btn' + (isCur ? ' sec' : ''), style: 'width:100%;justify-content:center;margin-top:auto', onclick: buy(p.plan) }, isCur ? (s?.status === 'active' ? 'Extend' : 'Renew') : 'Choose ' + p.plan) : null);
    })),
    h('div', { class: 'card' }, h('h3', {}, 'Payments & invoices'),
      d.payments.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Plan'), h('th', {}, 'Amount'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, ...d.payments.map(p => h('tr', {}, h('td', {}, date(p.created)), h('td', {}, `${p.plan} · ${p.interval}ly${p.kind === 'renewal' ? ' (auto-renewal)' : ''}`), h('td', {}, p.display),
          h('td', {}, h('span', { class: 'pill ' + ({ paid: 'ok', failed: 'bad', pending: 'warn' })[p.status] }, p.status), p.error ? h('div', { class: 'hint', style: 'margin:0' }, p.error) : null),
          h('td', {}, p.invoice_no ? h('a', { href: `/api/billing/invoices/${p.id}`, target: '_blank', rel: 'noopener' }, p.invoice_no) : null)))))
        : h('div', { class: 'hint' }, 'No payments yet.')));
}

/** Called on load when returning from checkout (?billing=<reference>). */
export async function handleBillingReturn(openSettings) {
  const ref = new URLSearchParams(location.search).get('billing'); if (!ref) return;
  history.replaceState(null, '', location.pathname + location.hash);
  try {
    const r = await api('/billing/verify', 'POST', { reference: ref });
    toast(r.payment.status === 'paid' ? `✅ Payment received — you're on the ${r.plan} plan` : r.payment.status === 'failed' ? `Payment failed: ${r.payment.error || 'declined'}` : 'Payment is still processing — we\'ll update your plan as soon as it is confirmed');
  } catch (e) { toast(e.message); }
  openSettings();
}

// ---------- platform console ----------
export async function renderPlatformBilling(page) {
  const d = await api('/platform/billing');
  appendTo(page,
    h('div', { class: 'grid' }, ...(d.revenue30.length ? d.revenue30.map(r => h('div', { class: 'stat ok' }, h('div', {}, h('b', {}, r.display), h('span', {}, `revenue, last 30 days (${r.n} payments)`)))) : [h('div', { class: 'stat' }, h('div', {}, h('b', {}, '—'), h('span', {}, 'no revenue yet')))]),
      ...d.subscriptions.map(s => h('div', { class: 'stat' }, h('div', {}, h('b', {}, s.n), h('span', {}, `${s.status.replace('_', ' ')} subscriptions`))))),
    h('div', { class: 'card' }, h('h3', {}, 'Payment providers'), h('p', { class: 'hint' }, 'Configured with environment variables: PAYSTACK_SECRET_KEY · FLUTTERWAVE_SECRET_KEY + FLUTTERWAVE_WEBHOOK_HASH · STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET. Webhook URL: ' + location.origin + '/api/billing/webhook/<provider>'),
      ...d.providers.map(p => h('div', { class: 'check' }, h('b', { style: 'flex:1' }, p.label), h('span', { class: 'pill ' + (p.configured ? 'ok' : '') }, p.configured ? 'connected' : 'not configured')))),
    h('div', { class: 'card' }, h('h3', {}, 'Prices & limits'), h('p', { class: 'hint' }, 'Prices in whole currency units. Leave a price empty to hide that option (e.g. "contact sales"). Limits of 0 mean unlimited. Which modules each plan includes is set under Plans & modules.'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Plan'), h('th', {}, '₦ / month'), h('th', {}, '₦ / year'), h('th', {}, '$ / month'), h('th', {}, '$ / year'), h('th', {}, 'Seats'), h('th', {}, 'Websites'), h('th', {}))),
        h('tbody', {}, ...d.plans.map(p => {
          const n = (v, w = 100) => h('input', { type: 'number', min: 0, value: v || '', style: `width:${w}px` });
          const f = { nm: n(p.prices.NGN?.month), ny: n(p.prices.NGN?.year, 110), um: n(p.prices.USD?.month, 80), uy: n(p.prices.USD?.year, 90), seats: n(p.limits.seats, 70), sites: n(p.limits.sites, 70) };
          return h('tr', {}, h('td', {}, h('b', {}, p.plan)), ...['nm', 'ny', 'um', 'uy', 'seats', 'sites'].map(k => h('td', {}, f[k])),
            h('td', {}, h('button', { class: 'btn sm', onclick: guard(async () => {
              const prices = {}; if (+f.nm.value || +f.ny.value) prices.NGN = { month: +f.nm.value || 0, year: +f.ny.value || 0 }; if (+f.um.value || +f.uy.value) prices.USD = { month: +f.um.value || 0, year: +f.uy.value || 0 };
              await api('/platform/billing/plans/' + p.plan, 'PUT', { prices, limits: { seats: +f.seats.value || 0, sites: +f.sites.value || 0 } }); toast('Saved');
            }) }, 'Save')));
        })))),
    h('div', { class: 'card' }, h('h3', {}, 'Recent payments'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Workspace'), h('th', {}, 'Plan'), h('th', {}, 'Amount'), h('th', {}, 'Provider'), h('th', {}, 'Status'))),
        h('tbody', {}, ...d.payments.map(p => h('tr', {}, h('td', {}, date(p.created)), h('td', {}, p.workspace), h('td', {}, `${p.plan} · ${p.interval}ly`), h('td', {}, p.display), h('td', {}, p.provider),
          h('td', {}, h('span', { class: 'pill ' + ({ paid: 'ok', failed: 'bad', pending: 'warn' })[p.status] }, p.status))))))));
}
