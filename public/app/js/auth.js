import { api, h, icon , $app } from './core.js';
import { es } from './realtime.js';
import { boot } from './shell.js';

// ---------- login ----------
export function renderLogin(mode = 'login') {
  if (es) es.close();
  const err = h('div', { class: 'err' });
  const f = { name: h('input', { placeholder: 'Your name', autocomplete: 'name' }), workspace: h('input', { placeholder: 'Company or team name' }),
    site: h('input', { placeholder: 'https://yourstore.com (optional)' }),
    email: h('input', { type: 'email', placeholder: 'you@company.com', autocomplete: 'username', required: true }),
    pw: h('input', { type: 'password', placeholder: mode === 'signup' ? 'At least 8 characters' : 'Password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: true }) };
  const signup = mode === 'signup', t0 = Date.now();
  const hp = h('input', { name: 'company_website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', style: 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0' });
  $app.replaceChildren(h('div', { class: 'login-bg' }, h('form', { class: 'login', onsubmit: async e => {
    e.preventDefault(); err.textContent = '';
    try {
      if (signup) await api('/auth/signup', 'POST', { name: f.name.value, workspace: f.workspace.value, domain: f.site.value, site_name: f.site.value ? f.site.value.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '', email: f.email.value, password: f.pw.value, company_website: hp.value, elapsed: Date.now() - t0 });
      else await api('/auth/login', 'POST', { email: f.email.value, password: f.pw.value });
      boot();
    } catch (x) { err.textContent = x.message; }
  } }, h('div', { class: 'logo' }, icon('logo')), h('h1', {}, signup ? 'Create your account' : 'Welcome back'),
    h('div', { class: 'hint' }, signup ? 'Free live chat, chatbot and shared inbox for your website' : 'Sign in to your Chatly dashboard'),
    signup ? [h('label', {}, 'Your name'), f.name, h('label', {}, 'Company / workspace'), f.workspace, h('label', {}, 'Website'), f.site] : null,
    h('label', {}, 'Email'), f.email, h('label', {}, 'Password'), f.pw, signup ? hp : null, err,
    h('button', { class: 'btn', style: 'width:100%;margin-top:18px;justify-content:center;padding:11px' }, signup ? 'Create account' : 'Sign in'),
    h('div', { class: 'hint', style: 'text-align:center;margin-top:14px' }, signup ? 'Already have an account? ' : 'New to Chatly? ',
      h('a', { href: '#', onclick: e => { e.preventDefault(); renderLogin(signup ? 'login' : 'signup'); } }, signup ? 'Sign in' : 'Create an account')))));
}

