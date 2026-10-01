// Account security: email verification, password reset, TOTP 2FA + recovery codes, sessions, login history, export, deletion.
import assert from 'node:assert/strict';
import net from 'node:net';
process.env.DB_FILE = ':memory:';
const { server } = await import('../server/index.js');
const { totp } = await import('../server/modules/auth/security.js');
await new Promise(r => server.listen(0, r));
const B = `http://localhost:${server.address().port}`;
const j = async (p, method = 'GET', body, cookie, ua = 'Mozilla/5.0 TestBrowser') => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', 'User-Agent': ua, ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers, raw: r };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieOf = r => r.headers.get('set-cookie')?.split(';')[0];

// fake SMTP that keeps decoded bodies
const mails = [];
const smtp = net.createServer(sock => {
  let data = false, buf = '', head = '';
  sock.write('220 fake\r\n');
  sock.on('data', d => {
    buf += d;
    if (data) { if (buf.includes('\r\n.\r\n')) { const raw = buf; buf = ''; data = false; const to = (head.match(/RCPT TO:<([^>]+)>/) || [])[1];
      const body = Buffer.from(raw.split('\r\n\r\n').slice(1).join('').replace(/\r\n\.\r\n$/, '').replace(/\s+/g, ''), 'base64').toString();
      const subject = Buffer.from((raw.match(/Subject: =\?UTF-8\?B\?(.*?)\?=/) || [])[1] || '', 'base64').toString();
      mails.push({ to, subject, body }); head = ''; sock.write('250 ok\r\n'); } return; }
    let i; while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2); head += line + '\n';
      if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n'); else if (/^AUTH/.test(line)) sock.write('235 ok\r\n');
      else if (/^(MAIL|RCPT)/.test(line)) sock.write('250 ok\r\n'); else if (line === 'DATA') { sock.write('354 go\r\n'); data = true; } else if (line === 'QUIT') sock.end('221 bye\r\n');
    }
  });
});
await new Promise(r => smtp.listen(0, r));
process.env.SMTP_URL = `smtp://u:p@127.0.0.1:${smtp.address().port}`;
const linkToken = (to, kind) => { const m = [...mails].reverse().find(x => x.to === to && x.body.includes(`#${kind}/`)); return m && m.body.match(new RegExp(`#${kind}/([\\w-]+)`))[1]; };

// ---------- email verification ----------
const su = await j('/api/auth/signup', 'POST', { name: 'Vee', email: 'vee@co.com', password: 'password1', workspace: 'VeeCo', elapsed: 9000 });
const vee = cookieOf(su); await sleep(300);
assert.equal((await j('/api/me', 'GET', null, vee)).body.user.email_verified, false, 'new accounts start unverified');
const vtok = linkToken('vee@co.com', 'verify'); assert.ok(vtok, 'verification email sent with link');
assert.equal((await j('/api/auth/verify', 'POST', { token: 'nope' })).status, 400);
assert.equal((await j('/api/auth/verify', 'POST', { token: vtok })).status, 200);
assert.equal((await j('/api/auth/verify', 'POST', { token: vtok })).status, 400, 'single use');
assert.equal((await j('/api/me', 'GET', null, vee)).body.user.email_verified, true);
assert.equal((await j('/api/auth/verify/resend', 'POST', null, vee)).body.alreadyVerified, true);

// ---------- password reset ----------
assert.equal((await j('/api/auth/forgot', 'POST', { email: 'nobody@co.com' })).status, 200, 'no account enumeration');
assert.equal((await j('/api/auth/forgot', 'POST', { email: 'vee@co.com' })).status, 200); await sleep(300);
const rtok = linkToken('vee@co.com', 'reset'); assert.ok(rtok, 'reset link emailed');
assert.ok(!mails.some(m => m.to === 'nobody@co.com'));
assert.equal((await j('/api/auth/reset', 'POST', { token: rtok, password: 'short' })).status, 400);
assert.equal((await j('/api/auth/reset', 'POST', { token: rtok, password: 'newpassword1' })).status, 200);
assert.equal((await j('/api/me', 'GET', null, vee)).status, 401, 'reset signs out every session');
assert.equal((await j('/api/auth/reset', 'POST', { token: rtok, password: 'another123' })).status, 400, 'reset link single use');
assert.equal((await j('/api/auth/login', 'POST', { email: 'vee@co.com', password: 'password1' })).status, 401);
let s1 = cookieOf(await j('/api/auth/login', 'POST', { email: 'vee@co.com', password: 'newpassword1' }));
assert.ok(s1);

// ---------- two-factor authentication ----------
const setup = (await j('/api/me/2fa/setup', 'POST', null, s1)).body;
assert.match(setup.secret, /^[A-Z2-7]{32}$/); assert.match(setup.otpauth, /^otpauth:\/\/totp\/Chatly:vee%40co\.com\?secret=/);
assert.equal((await j('/api/me/2fa/enable', 'POST', { code: '000000' }, s1)).status, 400);
const other = cookieOf(await j('/api/auth/login', 'POST', { email: 'vee@co.com', password: 'newpassword1' }, null, 'Other/1.0'));
const en = await j('/api/me/2fa/enable', 'POST', { code: totp(setup.secret) }, s1);
assert.equal(en.status, 200); assert.equal(en.body.recoveryCodes.length, 10);
assert.equal((await j('/api/me', 'GET', null, other)).status, 401, 'turning on 2FA signs out other sessions');
// sign in now needs a code
const step1 = await j('/api/auth/login', 'POST', { email: 'vee@co.com', password: 'newpassword1' });
assert.equal(step1.body.twoFactor, true); assert.ok(!cookieOf(step1), 'no session before the second factor');
assert.equal((await j('/api/auth/2fa', 'POST', { ticket: step1.body.ticket, code: '123456' })).status, 401);
await sleep(30_000 - (Date.now() % 30_000) + 50); // next 30s window so the code differs from the one used at enable
const ok2 = await j('/api/auth/2fa', 'POST', { ticket: step1.body.ticket, code: totp(setup.secret) });
assert.equal(ok2.status, 200); const s2 = cookieOf(ok2); assert.ok(s2);
// replay of the same code is refused
const step2 = await j('/api/auth/login', 'POST', { email: 'vee@co.com', password: 'newpassword1' });
assert.equal((await j('/api/auth/2fa', 'POST', { ticket: step2.body.ticket, code: totp(setup.secret) })).status, 401, 'code replay refused');
// recovery code works once
const rc = en.body.recoveryCodes[0];
const r1 = await j('/api/auth/2fa', 'POST', { ticket: step2.body.ticket, recovery: rc });
assert.equal(r1.status, 200); assert.equal(r1.body.recoveryCodesLeft, 9);
const step3 = await j('/api/auth/login', 'POST', { email: 'vee@co.com', password: 'newpassword1' });
assert.equal((await j('/api/auth/2fa', 'POST', { ticket: step3.body.ticket, recovery: rc })).status, 401, 'recovery code single use');
for (let i = 0; i < 4; i++) await j('/api/auth/2fa', 'POST', { ticket: step3.body.ticket, code: '000000' });
assert.equal((await j('/api/auth/2fa', 'POST', { ticket: step3.body.ticket, code: '000000' })).status, 429, 'ticket burned after 5 tries');
assert.equal((await j('/api/auth/2fa', 'POST', { ticket: 'forged', code: totp(setup.secret) })).status, 401);

// ---------- sessions & login history ----------
const sec = (await j('/api/me/security', 'GET', null, s2)).body;
assert.equal(sec.twoFactor, true); assert.equal(sec.recoveryCodesLeft, 9); assert.ok(sec.sessions.length >= 2);
assert.equal(sec.sessions.filter(s => s.current).length, 1);
assert.ok(sec.logins.some(l => !l.success && l.detail === 'wrong_password') && sec.logins.some(l => l.success && l.detail === '2fa') && sec.logins.some(l => l.detail === 'recovery_code'));
const otherSess = sec.sessions.find(s => !s.current);
assert.equal((await j('/api/me/sessions/' + sec.sessions.find(s => s.current).id, 'DELETE', null, s2)).status, 400);
assert.equal((await j('/api/me/sessions/' + otherSess.id, 'DELETE', null, s2)).status, 200);
assert.ok((await j('/api/me/sessions/revoke-others', 'POST', null, s2)).body.revoked >= 0);
assert.equal((await j('/api/me/security', 'GET', null, s2)).body.sessions.length, 1);
// disable needs password + code
assert.equal((await j('/api/me/2fa/disable', 'POST', { password: 'wrong', code: 'x' }, s2)).status, 403);
assert.equal((await j('/api/me/2fa/disable', 'POST', { password: 'newpassword1', code: en.body.recoveryCodes[1] }, s2)).status, 200);
assert.equal((await j('/api/auth/login', 'POST', { email: 'vee@co.com', password: 'newpassword1' })).body.ok, true, '2FA off again');

// ---------- data export & account deletion ----------
const exp = await j('/api/me/export', 'GET', null, s2);
const data = await (await fetch(B + '/api/me/export', { headers: { cookie: s2 } })).json();
assert.equal(data.profile.email, 'vee@co.com'); assert.equal(data.memberships[0].workspace, 'VeeCo'); assert.ok(data.logins.length > 3);
assert.match(exp.headers.get('content-disposition'), /chatly-my-data\.json/);
const roles = (await j('/api/roles', 'GET', null, s2)).body.roles;
await j('/api/members', 'POST', { name: 'Tia', email: 'tia@co.com', password: 'password1', role_id: roles.find(r => r.name === 'Agent').id }, s2);
assert.equal((await j('/api/me', 'DELETE', { password: 'newpassword1', confirm: 'DELETE' }, s2)).status, 400, 'sole owner of a team must hand over first');
const tia = cookieOf(await j('/api/auth/login', 'POST', { email: 'tia@co.com', password: 'password1' }));
assert.equal((await j('/api/me', 'DELETE', { password: 'password1', confirm: 'nope' }, tia)).status, 400);
assert.equal((await j('/api/me', 'DELETE', { password: 'password1', confirm: 'DELETE' }, tia)).status, 200);
assert.equal((await j('/api/auth/login', 'POST', { email: 'tia@co.com', password: 'password1' })).status, 401, 'account gone');
assert.ok((await j('/api/audit', 'GET', null, s2)).body.entries.some(e => e.action === 'member.account_deleted'));
assert.equal((await j('/api/me', 'DELETE', { password: 'newpassword1', confirm: 'DELETE' }, s2)).status, 200, 'alone now — deletes account and its workspace');
const root = cookieOf(await j('/api/auth/login', 'POST', { email: 'admin@example.com', password: 'admin123' }));
assert.ok(!(await j('/api/platform/workspaces?q=VeeCo', 'GET', null, root)).body.workspaces.length, 'solo workspace removed');
assert.equal((await j('/api/me', 'DELETE', { password: 'admin123', confirm: 'DELETE' }, root)).status, 400, 'last platform admin protected');

smtp.close();
console.log('all security tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
