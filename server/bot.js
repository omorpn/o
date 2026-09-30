import { db } from './db.js';

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const HUMAN_PHRASE = 'talk to a human';

export function parseRule(r) {
  return { ...r, buttons: JSON.parse(r.buttons || '[]'), handoff: !!r.handoff, enabled: !!r.enabled };
}

export function keywordScore(text, keywords) {
  const t = text.toLowerCase().trim(); let score = 0;
  for (const kw of keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)) {
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc(kw)}(?:s|es)?($|[^\\p{L}\\p{N}])`, 'u').test(t)) score += kw.length;
  }
  return score;
}

export function matchFlow(text) {
  let best = null, bestScore = 0;
  for (const f of db.prepare('SELECT * FROM flows WHERE enabled=1 ORDER BY id').all()) {
    const sc = keywordScore(text, f.keywords); if (sc > bestScore) { best = f; bestScore = sc; }
  }
  return best ? { ...best, nodes: JSON.parse(best.nodes) } : null;
}

export const NODE_TYPES = ['message', 'choice', 'ask', 'handoff', 'end'];
export const ASK_FIELDS = ['name', 'email', 'phone', 'text'];
/** Validates a flow's node list; returns an error string or null. */
export function validateNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 50) return 'A flow needs 1–50 steps';
  const ids = new Set();
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || !/^[\w-]{1,30}$/.test(n.id)) return 'Step ids must be letters, digits, - or _';
    if (ids.has(n.id)) return `Duplicate step id "${n.id}"`; ids.add(n.id);
    if (!NODE_TYPES.includes(n.type)) return `Unknown step type "${n.type}"`;
    if (n.type !== 'end' && !(typeof n.text === 'string' && n.text.trim())) return `Step "${n.id}" needs text`;
    if (n.type === 'ask' && !ASK_FIELDS.includes(n.field)) return `Step "${n.id}" has a bad field`;
    if (n.type === 'choice' && !(Array.isArray(n.options) && n.options.length && n.options.length <= 6 && n.options.every(o => o && typeof o.label === 'string' && o.label.trim()))) return `Step "${n.id}" needs 1–6 options with labels`;
  }
  for (const n of nodes) for (const nx of [n.next, ...(n.options || []).map(o => o.next)]) if (nx && !ids.has(nx)) return `Step "${n.id}" points to missing step "${nx}"`;
  return null;
}

/** Returns the best matching enabled rule for a message, or null. */
export function matchRule(text) {
  const t = text.toLowerCase().trim();
  if (!t) return null;
  let best = null, bestScore = 0;
  for (const raw of db.prepare('SELECT * FROM rules WHERE enabled=1 ORDER BY position, id').all()) {
    const score = keywordScore(text, raw.keywords);
    if (score > bestScore) { best = raw; bestScore = score; }
  }
  return best ? parseRule(best) : null;
}

const STOP = new Set('the a an is are do you i we to of and or for my your what how can it in on with me this that'.split(' '));
const words = t => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !STOP.has(w));

/** Knowledge-base lookup by word overlap with the question. */
export function matchKb(text) {
  const q = new Set(words(text)); if (!q.size) return null;
  let best = null, bestScore = 0;
  for (const e of db.prepare('SELECT * FROM kb').all()) {
    const ew = new Set(words(e.question + ' ' + e.question));
    let hit = 0; for (const w of q) if (ew.has(w)) hit++;
    const score = hit / Math.max(q.size, 1);
    if (hit >= 1 && score > bestScore) { best = e; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

/** Optional AI answer via the Claude API (needs ANTHROPIC_API_KEY). Returns null on any problem. */
export async function aiAnswer(history, instructions) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const kb = db.prepare('SELECT question, answer FROM kb').all().map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n');
  const system = `${instructions}\n\nAnswer ONLY from the knowledge base below. If you are not sure or the answer is not there, reply exactly: HANDOFF\n\nKnowledge base:\n${kb}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 400, system, messages: history }),
    });
    if (!r.ok) return null;
    const d = await r.json(); const t = (d.content?.[0]?.text || '').trim();
    return !t || t === 'HANDOFF' ? null : t;
  } catch { return null; }
}
