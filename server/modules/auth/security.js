/**
 * Account security (core): email verification, password reset, TOTP two-factor authentication with recovery codes,
 * session & login history, account deletion and personal data export.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, now, hashPassword, checkPassword } from '../../core/db.js';
import { fail, str, limit, EMAIL, secureReq } from '../../core/http.js';
import { defineModule } from '../../core/modules.js';
import { newSession, audit } from '../../core/auth.js';
import { sendMail, mailConfigured } from '../../core/mail.js';
import { kickUser } from '../../core/realtime.js';

for (const [t, col] of [['users', 'email_verified INTEGER NOT NULL DEFAULT 1'], ['users', 'totp_secret TEXT'], ['users', 'totp_enabled INTEGER NOT NULL DEFAULT 0'],
  ['users', 'totp_last_step INTEGER'], ['users', 'recovery_codes TEXT']]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`); } catch { /* exists */ }
}
db.exec(`
CREATE TABLE IF NOT EXISTS auth_tokens (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_events (id INTEGER PRIMARY KEY, user_id INTEGER, email TEXT, ip TEXT, ua TEXT, success INTEGER NOT NULL, detail TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_login_user ON login_events(user_id, id);
`);

const sha = s => createHash('sha256').update(String(s)).digest('hex');
const H = 3600_000;

// ---------- one-time tokens (verification, reset) ----------
export function issueToken(userId, kind, ttlMs) {
  const tok = randomBytes(24).toString('base64url');
  db.prepare('DELETE FROM auth_tokens WHERE user_id=? AND kind=?').run(userId, kind);
  db.prepare('INSERT INTO auth_tokens(hash,user_id,kind,expires) VALUES(?,?,?,?)').run(sha(tok), userId, kind, now() + ttlMs);
  return tok;
}
function consumeToken(tok, kind) {
  const row = db.prepare('SELECT * FROM auth_tokens WHERE hash=? AND kind=?').get(sha(str(tok, 100)), kind);
  if (!row || row.expires < now()) fail(400, 'This link is invalid or has expired. Request a new one.');
  db.prepare('DELETE FROM auth_tokens WHERE hash=?').run(row.hash);
  return row.user_id;
}
const baseUrl = req => (process.env.PUBLIC_URL || `${secureReq(req) ? 'https' : 'http'}://${req.headers.host}`).replace(/\/$/, '');
export function sendVerification(req, user) {
  if (!mailConfigured()) return false;
  const tok = issueToken(user.id, 'verify', 48 * H);
  sendMail({ to: user.email, subject: 'Confirm your email for Chatly', text: `Hi ${user.name},\n\nConfirm your email address by opening this link:\n${baseUrl(req)}/app/#verify/${tok}\n\nThe link expires in 48 hours.` }).catch(e => console.error('mail error:', e.message));
  return true;
}

// ---------- TOTP (RFC 6238) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32 = buf => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const unbase32 = s => { let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
export function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secret)).update(c).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
/** Checks a code within ±1 step and refuses re-use of the same or an older step (replay). */
function checkTotp(user, code) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const now0 = Math.floor(Date.now() / 30000);
  for (const step of [now0 - 1, now0, now0 + 1]) {
    if (user.totp_last_step && step <= user.totp_last_step) continue;
    if (timingSafeEqual(Buffer.from(totp(user.totp_secret, step)), Buffer.from(code))) { db.prepare('UPDATE users SET totp_last_step=? WHERE id=?').run(step, user.id); return true; }
  }
  return false;
}
function useRecoveryCode(user, code) {
  const list = JSON.parse(user.recovery_codes || '[]'), h = sha(String(code || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  const i = list.indexOf(h); if (i < 0) return false;
  list.splice(i, 1); db.prepare('UPDATE users SET recovery_codes=? WHERE id=?').run(JSON.stringify(list), user.id);
  return true;
}

// ---------- login hooks used by the auth module ----------
const pending = new Map(); // 2FA ticket -> { userId, expires, ip }
setInterval(() => { const t = now(); for (const [k, v] of pending) if (v.expires < t) pending.delete(k); }, 60_000).unref();
export function logLogin(req, ip, email, userId, success, detail) {
  db.prepare('INSERT INTO login_events(user_id,email,ip,ua,success,detail,created) VALUES(?,?,?,?,?,?,?)').run(userId ?? null, email, ip, str(req.headers['user-agent'], 200), success ? 1 : 0, detail || null, now());
}
/** After a correct password: either a 2FA challenge ticket, or null when 2FA is off. */
export function twoFactorChallenge(user, ip) {
  if (!user.totp_enabled) return null;
  const ticket = randomBytes(24).toString('base64url');
  pending.set(ticket, { userId: user.id, expires: now() + 5 * 60_000, ip, tries: 0 });
  return ticket;
}

export default defineModule({
  key: 'security', name: 'Account security', description: 'Verification, password reset, 2FA, sessions.', core: true, hidden: true,
  routes: [
    { method: 'POST', path: '/api/auth/2fa', auth: 'public', handler: async c => {
      const b = await c.body(), p = pending.get(str(b.ticket, 100));
      if (!p || p.expires < now()) fail(401, 'Your sign-in expired. Enter your password again.');
      if (++p.tries > 5) { pending.delete(b.ticket); fail(429, 'Too many wrong codes. Sign in again.'); }
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.userId);
      const ok = b.recovery ? useRecoveryCode(u, b.recovery) : checkTotp(u, b.code);
      if (!ok) { logLogin(c.req, c.ip, u.email, u.id, false, '2fa_failed'); fail(401, b.recovery ? 'That recovery code is not valid' : 'Wrong code — check your authenticator app'); }
      pending.delete(b.ticket);
      logLogin(c.req, c.ip, u.email, u.id, true, b.recovery ? 'recovery_code' : '2fa');
      db.prepare('UPDATE users SET last_login=?, last_ip=? WHERE id=?').run(now(), c.ip, u.id);
      newSession(c.res, c.req, u.id, db.prepare('SELECT workspace_id FROM members WHERE user_id=? ORDER BY created LIMIT 1').get(u.id)?.workspace_id ?? null);
      return { ok: true, recoveryCodesLeft: JSON.parse(db.prepare('SELECT recovery_codes FROM users WHERE id=?').get(u.id).recovery_codes || '[]').length };
    } },
    { method: 'POST', path: '/api/auth/forgot', auth: 'public', handler: async c => {
      limit('forgot:' + c.ip, 5, H);
      const email = str((await c.body()).email, 200).toLowerCase();
      if (!EMAIL.test(email)) fail(400, 'Enter a valid email address');
      if (!mailConfigured()) fail(503, 'Password reset by email is not available on this server. Ask your administrator to reset it.');
      const u = db.prepare('SELECT * FROM users WHERE email=? AND disabled=0').get(email);
      if (u) {
        limit('forgot-user:' + u.id, 3, H);
        const tok = issueToken(u.id, 'reset', H);
        sendMail({ to: u.email, subject: 'Reset your Chatly password', text: `Hi ${u.name},\n\nReset your password here (valid for 1 hour):\n${baseUrl(c.req)}/app/#reset/${tok}\n\nIf you didn't ask for this, ignore this email — your password stays the same.` }).catch(e => console.error('mail error:', e.message));
      }
      return { ok: true }; // same answer whether or not the account exists
    } },
    { method: 'POST', path: '/api/auth/reset', auth: 'public', handler: async c => {
      const b = await c.body();
      if (String(b.password || '').length < 8) fail(400, 'Password must be at least 8 characters');
      const uid = consumeToken(b.token, 'reset');
      db.prepare('UPDATE users SET pass=?, email_verified=1, locked_until=NULL WHERE id=?').run(hashPassword(String(b.password)), uid);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid); kickUser(uid);
      db.prepare('DELETE FROM login_failures WHERE email=(SELECT email FROM users WHERE id=?)').run(uid);
      return { ok: true };
    } },
    { method: 'POST', path: '/api/auth/verify', auth: 'public', handler: async c => {
      const uid = consumeToken((await c.body()).token, 'verify');
      db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(uid); return { ok: true };
    } },
    { method: 'POST', path: '/api/auth/verify/resend', auth: 'user', handler: c => {
      limit('verify:' + c.me.id, 3, H);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(c.me.id);
      if (u.email_verified) return { ok: true, alreadyVerified: true };
      if (!sendVerification(c.req, u)) fail(503, 'Email is not configured on this server');
      return { ok: true };
    } },
    { method: 'GET', path: '/api/me/security', auth: 'user', handler: c => {
      const u = db.prepare('SELECT email_verified, totp_enabled, recovery_codes FROM users WHERE id=?').get(c.me.id);
      return { emailVerified: !!u.email_verified, twoFactor: !!u.totp_enabled, recoveryCodesLeft: JSON.parse(u.recovery_codes || '[]').length, mail: mailConfigured(),
        sessions: db.prepare('SELECT rowid id, ip, ua, created, last_seen, token FROM sessions WHERE user_id=? ORDER BY COALESCE(last_seen, created) DESC').all(c.me.id)
          .map(s => ({ id: s.id, ip: s.ip, ua: s.ua, created: s.created, last_seen: s.last_seen || s.created, current: s.token === c.auth.tok })),
        logins: db.prepare('SELECT ip, ua, success, detail, created FROM login_events WHERE user_id=? ORDER BY id DESC LIMIT 20').all(c.me.id).map(l => ({ ...l, success: !!l.success })) };
    } },
    { method: 'DELETE', path: '/api/me/sessions/:id', auth: 'user', handler: c => {
      const s = db.prepare('SELECT rowid id, token FROM sessions WHERE rowid=? AND user_id=?').get(c.int('id'), c.me.id); if (!s) fail(404, 'Session not found');
      if (s.token === c.auth.tok) fail(400, 'Use “Sign out” to end this session');
      db.prepare('DELETE FROM sessions WHERE rowid=?').run(s.id); return {};
    } },
    { method: 'POST', path: '/api/me/sessions/revoke-others', auth: 'user', handler: c => {
      const n = db.prepare('DELETE FROM sessions WHERE user_id=? AND token!=?').run(c.me.id, c.auth.tok).changes; return { revoked: n };
    } },
    { method: 'POST', path: '/api/me/2fa/setup', auth: 'user', handler: c => {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(c.me.id);
      if (u.totp_enabled) fail(400, 'Two-factor authentication is already on');
      const secret = base32(randomBytes(20));
      db.prepare('UPDATE users SET totp_secret=?, totp_last_step=NULL WHERE id=?').run(secret, u.id);
      const issuer = encodeURIComponent(process.env.APP_NAME || 'Chatly');
      return { secret, otpauth: `otpauth://totp/${issuer}:${encodeURIComponent(u.email)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` };
    } },
    { method: 'POST', path: '/api/me/2fa/enable', auth: 'user', handler: async c => {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(c.me.id);
      if (!u.totp_secret) fail(400, 'Start setup first');
      if (!checkTotp(u, (await c.body()).code)) fail(400, 'That code is not right — check the time on your phone and try the newest code');
      const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
      db.prepare('UPDATE users SET totp_enabled=1, recovery_codes=? WHERE id=?').run(JSON.stringify(codes.map(x => sha(x.replace('-', '')))), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token!=?').run(u.id, c.auth.tok);
      return { recoveryCodes: codes };
    } },
    { method: 'POST', path: '/api/me/2fa/disable', auth: 'user', handler: async c => {
      const b = await c.body(), u = db.prepare('SELECT * FROM users WHERE id=?').get(c.me.id);
      if (!u.totp_enabled) return {};
      if (!checkPassword(String(b.password || ''), u.pass)) fail(403, 'Password is wrong');
      if (!(checkTotp(u, b.code) || useRecoveryCode(u, b.code))) fail(403, 'Code is wrong');
      db.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL, recovery_codes=NULL WHERE id=?').run(u.id); return {};
    } },
    { method: 'GET', path: '/api/me/export', auth: 'user', handler: c => {
      const id = c.me.id;
      const data = { exported_at: new Date().toISOString(), profile: db.prepare('SELECT id, name, email, created, last_login, email_verified, totp_enabled FROM users WHERE id=?').get(id),
        memberships: db.prepare('SELECT w.name workspace, r.name role, m.created FROM members m JOIN workspaces w ON w.id=m.workspace_id JOIN roles r ON r.id=m.role_id WHERE m.user_id=?').all(id),
        sessions: db.prepare('SELECT ip, ua, created, last_seen FROM sessions WHERE user_id=?').all(id),
        logins: db.prepare('SELECT ip, ua, success, detail, created FROM login_events WHERE user_id=? ORDER BY id DESC LIMIT 500').all(id),
        notifications: db.prepare('SELECT type, title, body, created, read_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 1000').all(id),
        messages_sent: db.prepare("SELECT conv_id, body, created FROM messages WHERE sender IN ('agent','note') AND sender_id=? ORDER BY id DESC LIMIT 5000").all(id) };
      c.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="chatly-my-data.json"' });
      c.res.end(JSON.stringify(data, null, 2));
    } },
    { method: 'DELETE', path: '/api/me', auth: 'user', handler: async c => {
      const b = await c.body(), u = db.prepare('SELECT * FROM users WHERE id=?').get(c.me.id);
      if (b.confirm !== 'DELETE') fail(400, 'Type DELETE to confirm');
      if (!checkPassword(String(b.password || ''), u.pass)) fail(403, 'Password is wrong');
      if (u.platform_role === 'superadmin' && db.prepare("SELECT COUNT(*) n FROM users WHERE platform_role='superadmin' AND disabled=0").get().n <= 1) fail(400, 'You are the only platform admin — make someone else admin first');
      // Workspaces where this user is the only Owner: delete if they're alone, otherwise refuse.
      const owned = db.prepare('SELECT m.workspace_id ws FROM members m JOIN roles r ON r.id=m.role_id WHERE m.user_id=? AND r.system=1').all(u.id);
      for (const { ws } of owned) {
        const owners = db.prepare('SELECT COUNT(*) n FROM members m JOIN roles r ON r.id=m.role_id WHERE m.workspace_id=? AND r.system=1').get(ws).n;
        const members = db.prepare('SELECT COUNT(*) n FROM members WHERE workspace_id=?').get(ws).n;
        if (owners <= 1 && members > 1) fail(400, `Make someone else Owner of “${db.prepare('SELECT name FROM workspaces WHERE id=?').get(ws).name}” before deleting your account`);
      }
      for (const { ws } of owned) if (db.prepare('SELECT COUNT(*) n FROM members WHERE workspace_id=?').get(ws).n <= 1) db.prepare('DELETE FROM workspaces WHERE id=?').run(ws);
      for (const m of db.prepare('SELECT workspace_id FROM members WHERE user_id=?').all(u.id)) audit(m.workspace_id, null, 'member.account_deleted', u.email);
      db.prepare('UPDATE conversations SET assignee_id=NULL WHERE assignee_id=?').run(u.id);
      kickUser(u.id); db.prepare('DELETE FROM users WHERE id=?').run(u.id);
      c.res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
      return { ok: true };
    } },
  ],
});
