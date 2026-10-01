/**
 * Encryption at rest for third-party credentials (channel access tokens, app secrets). Set DATA_KEY (any long random
 * string) to encrypt with AES-256-GCM; without it values are stored as-is (marked "plain:") so nothing breaks.
 * Changing DATA_KEY later makes previously encrypted values unreadable — reconnect the affected channels.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const key = () => (process.env.DATA_KEY ? createHash('sha256').update(process.env.DATA_KEY).digest() : null);
export function seal(value) {
  if (value == null || value === '') return null;
  const k = key(); if (!k) return 'plain:' + value;
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', k, iv), enc = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function unseal(stored) {
  if (!stored) return '';
  if (stored.startsWith('plain:')) return stored.slice(6);
  const k = key(); if (!k || !stored.startsWith('v1:')) return '';
  try {
    const b = Buffer.from(stored.slice(3), 'base64'), d = createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}
/** "EAAG…x9Qz" style preview for the dashboard; never return the secret itself. */
export const mask = v => (!v ? '' : v.length <= 8 ? '••••' : `${v.slice(0, 4)}…${v.slice(-4)}`);
