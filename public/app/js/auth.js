import { api, h, icon, $app } from './core.js';
import { es } from './realtime.js';
import { boot } from './shell.js';

// ---------- sign-in, sign-up, two-factor, password reset, email verification ----------
const card = (title, subtitle, ...body) => h('div', { class: 'login-bg' }, h('form', { class: 'login', onsubmit: e => e.preventDefault() },
  h('div', { class: 'logo' }, icon('logo')), h('h1', {}, title), subtitle ? h('div', { class: 'hint' }, subtitle) : null, ...body));
const wide = { class: 'btn', style: 'width:100%;margin-top:18px;justify-content:center;padding:11px' };
const linkTo = (text, fn) => h('a', { href: '#', onclick: e => { e.preventDefault(); fn(); } }, text);

export function renderLogin(mode = 'login') {
  if (es) es.close();
  if (mode === 'forgot') return renderForgot();
  const err = h('div', { class: 'err' });
  const f = { name: h('input', { placeholder: 'Your name', autocomplete: 'name' }), workspace: h('input', { placeholder: 'Company or team name' }),
    site: h('input', { placeholder: 'https://yourstore.com (optional)' }),
    email: h('input', { type: 'email', placeholder: 'you@company.com', autocomplete: 'username', required: true }),
    pw: h('input', { type: 'password', placeholder: mode === 'signup' ? 'At least 8 characters' : 'Password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: true }) };
  const signup = mode === 'signup', t0 = Date.now();
  const hp = h('input', { name: 'company_website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', style: 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0' });
  const submit = async () => {
    err.textContent = '';
    try {
      if (signup) { await api('/auth/signup', 'POST', { name: f.name.value, workspace: f.workspace.value, domain: f.site.value, site_name: f.site.value ? f.site.value.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '', email: f.email.value, password: f.pw.value, company_website: hp.value, elapsed: Date.now() - t0 }); return boot(); }
      const r = await api('/auth/login', 'POST', { email: f.email.value, password: f.pw.value });
      if (r.twoFactor) return renderTwoFactor(r.ticket);
      boot();
    } catch (x) { err.textContent = x.message; }
  };
  const el = card(signup ? 'Create your account' : 'Welcome back', signup ? 'Free live chat, chatbot and shared inbox for your website' : 'Sign in to your Chatly dashboard',
    signup ? [h('label', {}, 'Your name'), f.name, h('label', {}, 'Company / workspace'), f.workspace, h('label', {}, 'Website'), f.site] : null,
    h('label', {}, 'Email'), f.email,
    h('div', { class: 'row', style: 'margin:14px 0 5px' }, h('label', { class: 'grow', style: 'margin:0' }, 'Password'), signup ? null : h('span', { class: 'hint', style: 'margin:0' }, linkTo('Forgot password?', () => renderForgot(f.email.value)))),
    f.pw, signup ? hp : null, err,
    h('button', wide, signup ? 'Create account' : 'Sign in'),
    h('div', { class: 'hint', style: 'text-align:center;margin-top:14px' }, signup ? 'Already have an account? ' : 'New to Chatly? ', linkTo(signup ? 'Sign in' : 'Create an account', () => renderLogin(signup ? 'login' : 'signup'))));
  el.querySelector('form').onsubmit = e => { e.preventDefault(); submit(); };
  $app.replaceChildren(el);
}

function renderTwoFactor(ticket, recovery = false) {
  const err = h('div', { class: 'err' });
  const code = h('input', recovery ? { placeholder: 'xxxxx-xxxxx', autocomplete: 'off', required: true } : { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123 456', maxlength: 7, required: true, style: 'font-size:22px;letter-spacing:6px;text-align:center' });
  const el = card('Two-step verification', recovery ? 'Enter one of the recovery codes you saved when you turned on two-step verification.' : 'Enter the 6-digit code from your authenticator app.',
    h('label', {}, recovery ? 'Recovery code' : 'Code'), code, err, h('button', wide, 'Verify'),
    h('div', { class: 'hint', style: 'text-align:center;margin-top:14px' }, linkTo(recovery ? 'Use my authenticator app instead' : "Can't use your app? Use a recovery code", () => renderTwoFactor(ticket, !recovery)), ' · ', linkTo('Back', () => renderLogin())));
  el.querySelector('form').onsubmit = async e => {
    e.preventDefault(); err.textContent = '';
    try {
      const r = await api('/auth/2fa', 'POST', recovery ? { ticket, recovery: code.value } : { ticket, code: code.value });
      if (recovery) alert(`Signed in with a recovery code. You have ${r.recoveryCodesLeft} left — generate new ones under Settings → My account if you're running low.`);
      boot();
    } catch (x) { err.textContent = x.message; if (/expired|Sign in again/.test(x.message)) setTimeout(() => renderLogin(), 1500); }
  };
  $app.replaceChildren(el); code.focus();
}

function renderForgot(prefill = '') {
  const err = h('div', { class: 'err' }), email = h('input', { type: 'email', value: prefill, placeholder: 'you@company.com', required: true });
  const el = card('Reset your password', "Enter your email and we'll send you a link to choose a new password.", h('label', {}, 'Email'), email, err, h('button', wide, 'Send reset link'),
    h('div', { class: 'hint', style: 'text-align:center;margin-top:14px' }, linkTo('Back to sign in', () => renderLogin())));
  el.querySelector('form').onsubmit = async e => {
    e.preventDefault(); err.textContent = '';
    try { await api('/auth/forgot', 'POST', { email: email.value }); $app.replaceChildren(card('Check your email', `If an account exists for ${email.value}, a reset link is on its way. It works for 1 hour.`, h('div', { class: 'hint', style: 'text-align:center;margin-top:18px' }, linkTo('Back to sign in', () => renderLogin())))); }
    catch (x) { err.textContent = x.message; }
  };
  $app.replaceChildren(el);
}

function renderReset(token) {
  const err = h('div', { class: 'err' }), pw = h('input', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password', required: true }), pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const el = card('Choose a new password', 'You will be signed out everywhere else.', h('label', {}, 'New password'), pw, h('label', {}, 'Repeat it'), pw2, err, h('button', wide, 'Save password'));
  el.querySelector('form').onsubmit = async e => {
    e.preventDefault(); err.textContent = '';
    if (pw.value !== pw2.value) { err.textContent = "The passwords don't match"; return; }
    try { await api('/auth/reset', 'POST', { token, password: pw.value }); $app.replaceChildren(card('Password changed', 'You can sign in with your new password now.', h('button', { ...wide, onclick: () => renderLogin() }, 'Sign in'))); }
    catch (x) { err.textContent = x.message; }
  };
  $app.replaceChildren(el);
}

/** Handles #verify/<token> and #reset/<token> links from emails. Returns true when it took over the screen. */
export async function handleAuthLinks() {
  const m = location.hash.match(/^#(verify|reset)\/([\w-]+)$/); if (!m) return false;
  history.replaceState(null, '', location.pathname);
  if (m[1] === 'reset') { renderReset(m[2]); return true; }
  try { await api('/auth/verify', 'POST', { token: m[2] }); sessionStorage.setItem('chatly_flash', '✅ Email confirmed — thanks!'); }
  catch (x) { sessionStorage.setItem('chatly_flash', '⚠️ ' + x.message); }
  return false;
}
