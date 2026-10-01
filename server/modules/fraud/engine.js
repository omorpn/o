/**
 * Fraud & abuse detection. Every risky action gets a 0–100+ risk score built from explainable signals.
 * Scores at or above the review threshold create a review item; at or above the block threshold the
 * action is blocked (in "enforce" mode) or only logged (in "monitor" mode).
 */
import { db, now, getPlatform } from '../../core/db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS fraud_events (
  id INTEGER PRIMARY KEY, created INTEGER NOT NULL, kind TEXT NOT NULL, score INTEGER NOT NULL, action TEXT NOT NULL,
  workspace_id INTEGER, site_id INTEGER, user_id INTEGER, visitor_id TEXT, ip TEXT, email TEXT, summary TEXT, signals TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', reviewed_by TEXT, reviewed_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_fraud_status ON fraud_events(status, id);
CREATE INDEX IF NOT EXISTS idx_fraud_ws ON fraud_events(workspace_id, id);
CREATE TABLE IF NOT EXISTS blocklist (
  id INTEGER PRIMARY KEY, workspace_id INTEGER, type TEXT NOT NULL, value TEXT NOT NULL, reason TEXT,
  created_by TEXT, created INTEGER NOT NULL, expires INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_block_unique ON blocklist(COALESCE(workspace_id, 0), type, value);
CREATE TABLE IF NOT EXISTS login_failures (email TEXT, ip TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_lf_email ON login_failures(email, created);
CREATE INDEX IF NOT EXISTS idx_lf_ip ON login_failures(ip, created);
CREATE TABLE IF NOT EXISTS msg_fingerprints (hash TEXT NOT NULL, visitor_id TEXT, ip TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_fp ON msg_fingerprints(hash, created);
CREATE TABLE IF NOT EXISTS ip_visitors (ip TEXT NOT NULL, visitor_id TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (ip, visitor_id));
`);
for (const [t, col] of [['users', 'last_ip TEXT'], ['users', 'signup_ip TEXT'], ['users', 'locked_until INTEGER'], ['conversations', 'spam_score INTEGER'], ['conversations', 'spam INTEGER NOT NULL DEFAULT 0'], ['workspaces', 'risk_score INTEGER NOT NULL DEFAULT 0'], ['visitors', 'ip TEXT']]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`); } catch { /* exists */ }
}

export const FRAUD_DEFAULTS = { fraudMode: 'enforce', reviewThreshold: 40, blockThreshold: 70, autoSuspend: false, autoSuspendThreshold: 250 };
export const fraudSettings = () => { const p = getPlatform(); return Object.fromEntries(Object.keys(FRAUD_DEFAULTS).map(k => [k, p[k] ?? FRAUD_DEFAULTS[k]])); };

// ---------- reference data ----------
export const DISPOSABLE_DOMAINS = new Set(('mailinator.com guerrillamail.com guerrillamail.net 10minutemail.com 10minutemail.net tempmail.com temp-mail.org temp-mail.io throwawaymail.com yopmail.com yopmail.net ' +
  'getnada.com nada.email trashmail.com trashmail.de sharklasers.com dispostable.com maildrop.cc mintemail.com mohmal.com emailondeck.com fakeinbox.com tempinbox.com ' +
  'mailnesia.com mytemp.email tempr.email discard.email spamgourmet.com mailcatch.com getairmail.com burnermail.io moakt.com tmail.ws tmpmail.org tmpmail.net inboxkitten.com ' +
  'mail.tm emailfake.com fakemail.net 33mail.com spambox.us trashmail.ws mvrht.com anonbox.net deadaddress.com mailpoof.com').split(' '));
const SPAM_TERMS = ['bitcoin', 'crypto investment', 'forex', 'binary option', 'double your', 'earn $', 'make money fast', 'work from home', 'casino', 'betting tips', 'viagra', 'cialis',
  'seo services', 'rank your website', 'backlinks', 'guest post', 'loan offer', 'free money', 'lottery', 'you have won', 'claim your prize', 'click here', 'act now', 'wire transfer',
  'gift card', 'western union', 'onlyfans', 'adult content', 'telegram @', 'whatsapp +', 'dm me on', 'investment opportunity', 'nft drop', 'airdrop', 'recovery phrase', 'seed phrase'];
const PHISH_TERMS = ['verify your account', 'confirm your password', 'enter your password', 'account suspended', 'unusual activity', 'update your payment', 'login to continue', 'reset your password here', 'seed phrase', 'recovery phrase', 'card number', 'cvv'];
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 't.ly'];
const RISKY_TLDS = ['zip', 'mov', 'xyz', 'top', 'click', 'loan', 'work', 'gq', 'tk', 'ml', 'cf', 'ga', 'buzz', 'rest', 'country', 'kim'];
const BOT_UA = /(curl|wget|python-requests|python-urllib|aiohttp|httpclient|okhttp|go-http-client|java\/|libwww|scrapy|headlesschrome|phantomjs|puppeteer|selenium|node-fetch|axios)/i;
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+|[a-z0-9-]+\.(?:com|net|org|io|co|xyz|top|click|info|biz|ru|cn|tk|ml|ga|cf|gq|zip|mov|ly|me|link|site|online|shop|store|app)(?:\/[^\s<>"']*)?)/gi;

// ---------- helpers ----------
const H = 3600_000;
const sig = (list, code, weight, detail) => { list.push({ code, weight, detail }); };
const total = list => list.reduce((a, s) => a + s.weight, 0);
export const normEmail = e => String(e || '').trim().toLowerCase();
const domainOf = e => normEmail(e).split('@')[1] || '';
const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
const normText = t => String(t).toLowerCase().replace(/https?:\/\/\S+/g, 'URL').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

export function extractUrls(text) { return [...String(text).matchAll(URL_RE)].map(m => m[0]); }
function hostOf(u) { try { return new URL(/^https?:/i.test(u) ? u : 'http://' + u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }

/** Active blocklist match for (workspace or platform) scope. */
export function isBlocked(type, value, workspaceId = null) {
  if (!value) return null;
  return db.prepare('SELECT * FROM blocklist WHERE type=? AND value=? AND (workspace_id IS NULL OR workspace_id=?) AND (expires IS NULL OR expires>?) LIMIT 1')
    .get(type, String(value).toLowerCase(), workspaceId ?? -1, now()) || null;
}
export function addBlock({ workspaceId = null, type, value, reason, by, ttlMs = null }) {
  const v = String(value).trim().toLowerCase(); if (!v) return;
  db.prepare(`INSERT INTO blocklist(workspace_id,type,value,reason,created_by,created,expires) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT DO UPDATE SET reason=excluded.reason, expires=excluded.expires, created_by=excluded.created_by, created=excluded.created`)
    .run(workspaceId, type, v, reason || null, by || 'system', now(), ttlMs ? now() + ttlMs : null);
}

/** Records a scored event; returns the decided action. */
export function record({ kind, signals, workspaceId = null, siteId = null, userId = null, visitorId = null, ip = null, email = null, summary = '' }) {
  const s = fraudSettings(), score = total(signals);
  let action = 'allowed';
  if (score >= s.blockThreshold) action = s.fraudMode === 'enforce' ? 'blocked' : 'would_block';
  else if (score >= s.reviewThreshold) action = 'flagged';
  if (score >= s.reviewThreshold || signals.some(x => x.weight >= 100)) {
    db.prepare('INSERT INTO fraud_events(created,kind,score,action,workspace_id,site_id,user_id,visitor_id,ip,email,summary,signals,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(now(), kind, score, action, workspaceId, siteId, userId, visitorId, ip, email, String(summary).slice(0, 500), JSON.stringify(signals), action === 'allowed' ? 'dismissed' : 'open');
    if (workspaceId) bumpWorkspaceRisk(workspaceId);
    if (action !== 'allowed') emit('fraud.detected', { kind, score, action, workspaceId, summary: String(summary).slice(0, 140) });
  }
  return { score, action, signals, blocked: action === 'blocked' };
}

// ---------- 1. sign-up ----------
export function scoreSignup({ email, name, workspace, ip, ua, honeypot, elapsedMs }) {
  const signals = [], dom = domainOf(email), local = normEmail(email).split('@')[0] || '';
  if (honeypot) sig(signals, 'honeypot', 100, 'Hidden form field was filled in (bot)');
  if (elapsedMs == null || !Number.isFinite(+elapsedMs)) sig(signals, 'no_timing', 20, 'Form submitted without the browser timing token');
  else if (+elapsedMs < 2500) sig(signals, 'too_fast', 40, `Form completed in ${Math.round(elapsedMs)}ms`);
  if (DISPOSABLE_DOMAINS.has(dom)) sig(signals, 'disposable_email', 45, `Disposable email domain ${dom}`);
  const b = isBlocked('email', normEmail(email)) || isBlocked('email_domain', dom) || isBlocked('ip', ip);
  if (b) sig(signals, 'blocklisted', 100, `On blocklist (${b.type}: ${b.value})`);
  const sameIp = db.prepare('SELECT COUNT(*) n FROM users WHERE signup_ip=? AND created>?').get(ip, now() - 24 * H).n;
  if (sameIp >= 6) sig(signals, 'ip_velocity_high', 60, `${sameIp} sign-ups from this IP in 24h`);
  else if (sameIp >= 3) sig(signals, 'ip_velocity', 30, `${sameIp} sign-ups from this IP in 24h`);
  const digits = (local.match(/\d/g) || []).length;
  if (local.length >= 8 && digits / local.length > 0.5) sig(signals, 'random_email', 10, 'Email looks auto-generated');
  if (/(https?:\/\/|www\.)/i.test(`${name} ${workspace}`)) sig(signals, 'url_in_name', 25, 'Name contains a link');
  if (BOT_UA.test(ua || '')) sig(signals, 'bot_user_agent', 35, 'Automated client');
  if (!ua) sig(signals, 'no_user_agent', 15, 'No browser user agent');
  return signals;
}

// ---------- 2. login / account takeover ----------
export function loginGuard(email, ip) {
  const e = normEmail(email), t = now();
  const u = db.prepare('SELECT locked_until FROM users WHERE email=?').get(e);
  if (u?.locked_until > t) return { locked: true, retryInSec: Math.ceil((u.locked_until - t) / 1000), reason: 'Too many failed sign-in attempts' };
  const b = isBlocked('ip', ip);
  if (b) return { locked: true, retryInSec: b.expires ? Math.ceil((b.expires - t) / 1000) : null, reason: 'Sign-ins from your network are temporarily blocked' };
  return { locked: false };
}
export function loginFailed(email, ip) {
  const e = normEmail(email), t = now();
  db.prepare('INSERT INTO login_failures(email,ip,created) VALUES(?,?,?)').run(e, ip, t);
  const perEmail = db.prepare('SELECT COUNT(*) n FROM login_failures WHERE email=? AND created>?').get(e, t - 15 * 60_000).n;
  const perIp = db.prepare('SELECT COUNT(*) n FROM login_failures WHERE ip=? AND created>?').get(ip, t - H).n;
  const emailsPerIp = db.prepare('SELECT COUNT(DISTINCT email) n FROM login_failures WHERE ip=? AND created>?').get(ip, t - H).n;
  const user = db.prepare('SELECT id FROM users WHERE email=?').get(e);
  if (perEmail >= 5 && user) {
    const mins = Math.min(60, 15 * 2 ** Math.max(0, Math.floor((perEmail - 5) / 5)));
    db.prepare('UPDATE users SET locked_until=? WHERE id=?').run(t + mins * 60_000, user.id);
    record({ kind: 'login', userId: user.id, ip, email: e, summary: `Account locked for ${mins} min after ${perEmail} failed sign-ins`,
      signals: [{ code: 'brute_force', weight: 45, detail: `${perEmail} failed passwords in 15 min` }] });
  }
  if (emailsPerIp >= 10 || perIp >= 30) {
    addBlock({ type: 'ip', value: ip, reason: `Credential stuffing: ${perIp} failures across ${emailsPerIp} accounts`, ttlMs: H });
    record({ kind: 'login', ip, email: e, summary: `IP blocked for 1h: credential stuffing (${emailsPerIp} accounts)`,
      signals: [{ code: 'credential_stuffing', weight: 80, detail: `${perIp} failed sign-ins for ${emailsPerIp} different accounts in 1h` }] });
  }
}
export function loginSucceeded(user, ip) {
  const u = db.prepare('SELECT last_ip FROM users WHERE id=?').get(user.id);
  db.prepare('UPDATE users SET last_ip=?, locked_until=NULL WHERE id=?').run(ip, user.id);
  const recentFails = db.prepare('SELECT COUNT(*) n FROM login_failures WHERE email=? AND created>?').get(normEmail(user.email), now() - H).n;
  if (u?.last_ip && u.last_ip !== ip && recentFails >= 3) {
    record({ kind: 'login', userId: user.id, ip, email: user.email, summary: 'Sign-in from a new network right after several failed attempts (possible account takeover)',
      signals: [{ code: 'new_ip_after_failures', weight: 45, detail: `${recentFails} failures in the last hour, previous IP ${u.last_ip}` }] });
  }
}

// ---------- 3. visitor messages ----------
export function visitorBlocked(site, vkey, ip) {
  return isBlocked('visitor', vkey, site.workspace_id) || isBlocked('ip', ip, site.workspace_id);
}
export function scoreVisitorMessage({ site, vkey, ip, ua, text, spamFilter = 'normal' }) {
  const signals = [], t = now(), lower = String(text).toLowerCase();
  if (spamFilter === 'off') return signals;
  const strict = spamFilter === 'strict' ? 1.4 : 1;
  const w = n => Math.round(n * strict);
  const urls = extractUrls(text);
  if (urls.length) sig(signals, 'links', w(Math.min(45, urls.length * 15)), `${urls.length} link(s)`);
  const hosts = urls.map(hostOf).filter(Boolean);
  const short = hosts.filter(h => SHORTENERS.includes(h));
  if (short.length) sig(signals, 'url_shortener', w(20), `Shortened link: ${short[0]}`);
  const risky = hosts.filter(h => RISKY_TLDS.includes(h.split('.').pop()));
  if (risky.length) sig(signals, 'risky_tld', w(20), `Suspicious domain: ${risky[0]}`);
  if (hosts.some(h => /^\d+\.\d+\.\d+\.\d+$/.test(h))) sig(signals, 'ip_link', w(25), 'Link to a bare IP address');
  const terms = SPAM_TERMS.filter(k => lower.includes(k));
  if (terms.length) sig(signals, 'spam_terms', w(Math.min(45, terms.length * 18)), `Spam phrases: ${terms.slice(0, 3).join(', ')}`);
  const custom = db.prepare("SELECT value FROM blocklist WHERE type='keyword' AND (workspace_id IS NULL OR workspace_id=?) AND (expires IS NULL OR expires>?)").all(site.workspace_id, t)
    .map(r => r.value).filter(k => lower.includes(k));
  if (custom.length) sig(signals, 'blocked_keyword', 100, `Blocked word: ${custom[0]}`);
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 30 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8) sig(signals, 'shouting', 10, 'Mostly capital letters');
  if (text.length > 1500) sig(signals, 'very_long', 10, `${text.length} characters`);
  // campaign detection: the same (normalised) message from several visitors across the whole platform
  const fp = hash(normText(text));
  if (normText(text).length > 25) {
    db.prepare('INSERT INTO msg_fingerprints(hash,visitor_id,ip,created) VALUES(?,?,?,?)').run(fp, vkey, ip, t);
    const same = db.prepare('SELECT COUNT(DISTINCT visitor_id) n FROM msg_fingerprints WHERE hash=? AND created>?').get(fp, t - 30 * 60_000).n;
    if (same >= 8) sig(signals, 'spam_campaign', 80, `Same message sent by ${same} visitors in 30 min`);
    else if (same >= 5) sig(signals, 'spam_campaign', 60, `Same message sent by ${same} visitors in 30 min`);
    else if (same >= 3) sig(signals, 'repeated_message', 30, `Same message sent by ${same} visitors in 30 min`);
  }
  const perMin = db.prepare("SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conv_id WHERE c.visitor_id=? AND m.sender='visitor' AND m.created>?").get(vkey, t - 60_000).n;
  if (perMin >= 12) sig(signals, 'flooding', 35, `${perMin} messages in the last minute`);
  db.prepare('INSERT OR IGNORE INTO ip_visitors(ip,visitor_id,created) VALUES(?,?,?)').run(ip, vkey, t);
  const vids = db.prepare('SELECT COUNT(*) n FROM ip_visitors WHERE ip=? AND created>?').get(ip, t - H).n;
  if (vids >= 15) sig(signals, 'many_identities', 30, `${vids} different visitor IDs from one IP in 1h`);
  if (BOT_UA.test(ua || '')) sig(signals, 'bot_user_agent', 30, 'Automated client');
  else if (!ua) sig(signals, 'no_user_agent', 15, 'No browser user agent');
  return signals;
}

// ---------- 4. businesses abusing the platform (outbound phishing from agents) ----------
export function scoreAgentMessage({ text }) {
  const signals = [], lower = String(text).toLowerCase(), hosts = extractUrls(text).map(hostOf).filter(Boolean);
  const phish = PHISH_TERMS.filter(k => lower.includes(k));
  if (phish.length && hosts.length) sig(signals, 'phishing_pattern', 55, `Credential request with a link: "${phish[0]}"`);
  else if (phish.length) sig(signals, 'credential_request', 20, `Asks for credentials: "${phish[0]}"`);
  if (hosts.some(h => SHORTENERS.includes(h))) sig(signals, 'url_shortener', 20, 'Shortened link sent to visitor');
  if (hosts.some(h => RISKY_TLDS.includes(h.split('.').pop()))) sig(signals, 'risky_tld', 20, 'Suspicious domain sent to visitor');
  return signals;
}

// ---------- workspace risk ----------
export function bumpWorkspaceRisk(workspaceId) {
  const t = now();
  const r = db.prepare("SELECT COALESCE(SUM(score),0) s FROM fraud_events WHERE workspace_id=? AND created>? AND status!='dismissed' AND kind IN ('signup','agent_message','workspace')").get(workspaceId, t - 7 * 24 * H).s;
  const visitorSpam = db.prepare("SELECT COUNT(*) n FROM fraud_events WHERE workspace_id=? AND created>? AND kind='visitor_message'").get(workspaceId, t - 24 * H).n;
  const risk = Math.round(r + Math.min(40, visitorSpam));
  db.prepare('UPDATE workspaces SET risk_score=? WHERE id=?').run(risk, workspaceId);
  return risk;
}

export function cleanup() {
  const t = now();
  db.prepare('DELETE FROM login_failures WHERE created<?').run(t - 24 * H);
  db.prepare('DELETE FROM msg_fingerprints WHERE created<?').run(t - 2 * H);
  db.prepare('DELETE FROM ip_visitors WHERE created<?').run(t - 2 * H);
  db.prepare('DELETE FROM blocklist WHERE expires IS NOT NULL AND expires<?').run(t);
}
setInterval(cleanup, 10 * 60_000).unref();

// ---------- automatic suspension ----------
import { emit } from '../../core/events.js';
import { audit, platformAudit } from '../../core/auth.js';
import { kickWorkspace } from '../../core/realtime.js';

/** Suspends a workspace automatically when its fraud risk crosses the platform threshold (only if enabled). */
export function maybeAutoSuspend(ws) {
  const f = fraudSettings(); if (!f.autoSuspend || f.fraudMode !== 'enforce') return;
  const w = db.prepare('SELECT suspended, risk_score, name FROM workspaces WHERE id=?').get(ws);
  if (!w || w.suspended || w.risk_score < f.autoSuspendThreshold) return;
  const reason = `Automatically suspended for review: suspected abuse (risk ${w.risk_score})`;
  suspendWorkspace(ws, reason, null);
  platformAudit({ name: 'fraud engine' }, 'workspace.auto_suspended', `${w.name} (#${ws}) risk ${w.risk_score}`);
}

/** Suspends a workspace: blocks its dashboard, widget and live connections. */
export function suspendWorkspace(ws, reason, by) {
  db.prepare('UPDATE workspaces SET suspended=1, suspended_reason=? WHERE id=?').run(reason, ws);
  audit(ws, by ? { id: by.id, name: `${by.name} (platform)` } : null, 'workspace.suspended', reason);
  kickWorkspace(ws);
  emit('workspace.suspended', { ws, reason });
}
