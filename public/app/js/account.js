// Settings → My account: profile, password, two-step verification, sessions, login history, data export, deletion.
import { S, api, appendTo, guard, h, toast } from './core.js';
import { boot, renderShell } from './shell.js';
import { renderLogin } from './auth.js';

const device = ua => !ua ? 'Unknown device' : `${/Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua.split(/[ /]/)[0]} on ${/Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? (/iPhone|iPad/.test(ua) ? 'iOS' : 'macOS') : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'unknown OS'}`;
const when = t => new Date(t).toLocaleString();

export async function renderAccount(page) {
  const sec = await api('/me/security');
  const nm = h('input', { value: S.me.name }), cur = h('input', { type: 'password', autocomplete: 'current-password' }), nw = h('input', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
  const rerender = () => renderShell();
  appendTo(page, h('div', { class: 'grid2', style: 'align-items:start' },
    h('div', {},
      h('div', { class: 'card' }, h('h3', {}, 'Profile'), h('label', {}, 'Name'), nm, h('label', {}, 'Email'), h('input', { value: S.me.email, disabled: true }),
        h('div', { class: 'row', style: 'margin-top:8px' }, sec.emailVerified ? h('span', { class: 'pill ok' }, '✓ email confirmed') : [h('span', { class: 'pill warn' }, 'email not confirmed'),
          sec.mail ? h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('/auth/verify/resend', 'POST'); toast('Confirmation email sent'); }) }, 'Resend link') : null]),
        h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { await api('/me', 'PUT', { name: nm.value }); toast('Saved'); await boot(); }) }, 'Save')),
      h('div', { class: 'card' }, h('h3', {}, 'Change password'), h('div', { class: 'hint' }, 'Signs you out on all other devices.'), h('label', {}, 'Current password'), cur, h('label', {}, 'New password'), nw,
        h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { await api('/me/password', 'POST', { current: cur.value, password: nw.value }); cur.value = nw.value = ''; toast('Password updated'); rerender(); }) }, 'Update password')),
      twoFactorCard(sec, rerender)),
    h('div', {},
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Where you\'re signed in'),
        sec.sessions.length > 1 ? h('button', { class: 'btn sec sm', onclick: guard(async () => { const r = await api('/me/sessions/revoke-others', 'POST'); toast(`Signed out ${r.revoked} other session(s)`); rerender(); }) }, 'Sign out all others') : null),
        ...sec.sessions.map(s => h('div', { class: 'check' }, h('div', { style: 'flex:1' }, h('b', {}, device(s.ua)), s.current ? h('span', { class: 'pill ok', style: 'margin-left:6px' }, 'this device') : null,
          h('div', { class: 'hint', style: 'margin:0' }, `${s.ip || 'unknown IP'} · last active ${when(s.last_seen)}`)),
          s.current ? null : h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('/me/sessions/' + s.id, 'DELETE'); toast('Signed out'); rerender(); }) }, 'Sign out')))),
      h('div', { class: 'card' }, h('h3', {}, 'Recent sign-ins'), h('div', { class: 'hint' }, "If you don't recognise one, change your password and sign out all other sessions."),
        h('table', {}, h('tbody', {}, ...sec.logins.map(l => h('tr', {}, h('td', {}, l.success ? '✅' : '❌'), h('td', {}, when(l.created)), h('td', {}, device(l.ua)), h('td', { class: 'hint' }, `${l.ip || ''}${l.detail ? ' · ' + l.detail.replace(/_/g, ' ') : ''}`)))))),
      h('div', { class: 'card' }, h('h3', {}, 'Your data'), h('p', { class: 'hint' }, 'Download a copy of your profile, memberships, sessions, sign-ins, notifications and the messages you sent.'),
        h('a', { class: 'btn sec', href: '/api/me/export', style: 'text-decoration:none' }, 'Download my data'),
        h('h4', { class: 'dh' }, 'Delete account'), h('p', { class: 'hint' }, 'Permanently deletes your login. Workspaces where you are the only member are deleted too; if you own a workspace with a team, make someone else Owner first.'),
        h('button', { class: 'btn danger', onclick: guard(async () => {
          const pw = prompt('Enter your password to delete your account'); if (!pw) return;
          if (prompt('This cannot be undone. Type DELETE to confirm') !== 'DELETE') return;
          await api('/me', 'DELETE', { password: pw, confirm: 'DELETE' }); S.me = null; renderLogin();
        }) }, 'Delete my account')))));
}

function twoFactorCard(sec, rerender) {
  const box = h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Two-step verification'), h('span', { class: 'pill ' + (sec.twoFactor ? 'ok' : 'warn') }, sec.twoFactor ? 'on' : 'off')),
    h('p', { class: 'hint' }, 'Protect your account with a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) every time you sign in.'));
  if (sec.twoFactor) {
    const pw = h('input', { type: 'password', placeholder: 'Password' }), code = h('input', { placeholder: 'Code or recovery code', autocomplete: 'one-time-code' });
    appendTo(box, h('p', { class: 'hint' }, `${sec.recoveryCodesLeft} recovery code(s) left.`), h('details', {}, h('summary', { class: 'hint', style: 'cursor:pointer' }, 'Turn off two-step verification'),
      h('div', { class: 'grid2', style: 'margin-top:8px' }, pw, code), h('button', { class: 'btn danger sm', style: 'margin-top:8px', onclick: guard(async () => { await api('/me/2fa/disable', 'POST', { password: pw.value, code: code.value }); toast('Two-step verification is off'); rerender(); }) }, 'Turn off')));
    return box;
  }
  const start = h('button', { class: 'btn', onclick: guard(async () => {
    const s = await api('/me/2fa/setup', 'POST');
    const code = h('input', { inputmode: 'numeric', placeholder: '123456', maxlength: 6, style: 'font-size:20px;letter-spacing:5px;width:170px' });
    start.replaceWith(h('div', {},
      h('ol', { class: 'steps' }, h('li', {}, 'Open your authenticator app and add an account.'),
        h('li', {}, 'Scan or tap ', h('a', { href: s.otpauth }, 'this setup link'), ', or type this key: ', h('code', { class: 'secret' }, s.secret.match(/.{1,4}/g).join(' '))),
        h('li', {}, 'Enter the 6-digit code the app shows:')),
      h('div', { class: 'row' }, code, h('button', { class: 'btn', onclick: guard(async () => {
        const r = await api('/me/2fa/enable', 'POST', { code: code.value });
        box.replaceChildren(h('h3', {}, '✅ Two-step verification is on'), h('p', {}, h('b', {}, 'Save these recovery codes now.'), ' Each works once if you lose your phone. They will not be shown again.'),
          h('pre', { class: 'code' }, r.recoveryCodes.join('\n')),
          h('div', { class: 'row' }, h('button', { class: 'btn sec', onclick: () => { navigator.clipboard?.writeText(r.recoveryCodes.join('\n')); toast('Copied'); } }, 'Copy'),
            h('button', { class: 'btn', onclick: rerender }, "I've saved them")));
      }) }, 'Turn on'))));
    code.focus();
  }) }, 'Set up two-step verification');
  box.append(start);
  return box;
}
