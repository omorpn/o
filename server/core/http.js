/** HTTP primitives shared by every module: JSON responses, errors, body parsing, rate limits, client IP. */
import { now } from './db.js';

export class HttpError extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
export const fail = (code, msg, extra) => { throw new HttpError(code, msg, extra); };

export function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj ?? {}));
}

export async function readBody(req, max = 200_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) fail(413, 'Payload too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'Invalid JSON'); }
}

export const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
export const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const toInt = v => { const n = Number(v); if (!Number.isInteger(n)) fail(400, 'Bad id'); return n; };

const hits = new Map();
/** Sliding-window rate limit; throws 429 when `key` exceeded `max` calls in `windowMs`. */
export function limit(key, max, windowMs) {
  const t = now(); const arr = (hits.get(key) || []).filter(x => t - x < windowMs);
  if (arr.length >= max) fail(429, 'Too many requests, slow down');
  arr.push(t); hits.set(key, arr);
}
setInterval(() => { const t = now(); for (const [k, v] of hits) if (!v.some(x => t - x < 3_600_000)) hits.delete(k); }, 60_000).unref();

// TRUST_PROXY = number of proxy hops in front of the app (Cloud Run: 1, Firebase Hosting → Cloud Run: 2)
const HOPS = Number(process.env.TRUST_PROXY) || 0;
export function ipOf(req) {
  if (HOPS) { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean); if (x.length >= HOPS) return x[x.length - HOPS]; }
  return req.socket.remoteAddress || '';
}
export const secureReq = req => req.socket.encrypted || (HOPS && /https/i.test(String(req.headers['x-forwarded-proto'] || '')));
