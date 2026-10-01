/**
 * Web Push without dependencies: VAPID (RFC 8292) signed requests carrying an aes128gcm-encrypted payload (RFC 8291).
 * Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, raw P-256) or are generated once and stored.
 */
import { generateKeyPairSync, createPrivateKey, createECDH, randomBytes, hkdfSync, createCipheriv, sign } from 'node:crypto';
import { db } from '../../core/db.js';

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(String(s), 'base64url');

let keys;
/** { publicKey: base64url 65-byte point, privateKey: KeyObject } */
export function vapidKeys() {
  if (keys) return keys;
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key='vapid'").get();
    if (row) ({ pub, priv } = JSON.parse(row.value));
    else {
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = privateKey.export({ format: 'jwk' });
      pub = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])); priv = jwk.d;
      db.prepare("INSERT INTO platform_settings(key,value) VALUES('vapid',?)").run(JSON.stringify({ pub, priv }));
    }
  }
  const raw = fromB64u(pub);
  const privateKey = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: priv, x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) } });
  return (keys = { publicKey: pub, privateKey });
}

export function vapidJwt(audience, subject) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapidKeys().privateKey, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64u(sig)}`;
}

/** Encrypts `payload` for a subscription (RFC 8291, aes128gcm, single record). */
export function encrypt(payload, p256dh, authSecret) {
  const uaPublic = fromB64u(p256dh), auth = fromB64u(authSecret);
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(), secret = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

// Push services browsers actually use. Other endpoints are refused so the server can't be pointed at internal URLs.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
export function endpointAllowed(endpoint) {
  let u; try { u = new URL(endpoint); } catch { return false; }
  if (process.env.ALLOW_INSECURE_PUSH === '1') return /^https?:$/.test(u.protocol);
  return u.protocol === 'https:' && PUSH_HOSTS.some(re => re.test(u.hostname));
}

/** Sends one push. Resolves 'ok' | 'gone' (subscription expired, delete it) | 'error'. */
export async function sendPush(sub, data, { ttl = 86400, urgency = 'normal' } = {}) {
  const u = new URL(sub.endpoint);
  const subject = process.env.VAPID_SUBJECT || `mailto:${db.prepare("SELECT email FROM users WHERE platform_role='superadmin' ORDER BY id LIMIT 1").get()?.email || 'admin@example.com'}`;
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', signal: AbortSignal.timeout(10_000), body: encrypt(JSON.stringify(data), sub.p256dh, sub.auth),
      headers: { TTL: String(ttl), Urgency: urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        Authorization: `vapid t=${vapidJwt(`${u.protocol}//${u.host}`, subject)}, k=${vapidKeys().publicKey}` } });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok ? 'ok' : 'error';
  } catch { return 'error'; }
}
