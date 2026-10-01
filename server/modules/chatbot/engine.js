import { db } from '../../core/db.js';
import { keywordScore } from '../../core/text.js';


export function parseRule(r) {
  return { ...r, buttons: JSON.parse(r.buttons || '[]'), handoff: !!r.handoff, enabled: !!r.enabled };
}


/** Returns the best matching enabled rule for a message, or null. */
export function matchRule(siteId, text) {
  const t = text.toLowerCase().trim();
  if (!t) return null;
  let best = null, bestScore = 0;
  for (const raw of db.prepare('SELECT * FROM rules WHERE site_id=? AND enabled=1 ORDER BY position, id').all(siteId)) {
    const score = keywordScore(text, raw.keywords);
    if (score > bestScore) { best = raw; bestScore = score; }
  }
  return best ? parseRule(best) : null;
}

const STOP = new Set('the a an is are do you i we to of and or for my your what how can it in on with me this that'.split(' '));
const words = t => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !STOP.has(w));

/** Knowledge-base lookup by word overlap with the question. */
export function matchKb(siteId, text) {
  const q = new Set(words(text)); if (!q.size) return null;
  let best = null, bestScore = 0;
  for (const e of db.prepare('SELECT * FROM kb WHERE site_id=?').all(siteId)) {
    const ew = new Set(words(e.question + ' ' + e.question));
    let hit = 0; for (const w of q) if (ew.has(w)) hit++;
    const score = hit / Math.max(q.size, 1);
    if (hit >= 1 && score > bestScore) { best = e; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

/** Optional AI answer via the Claude API (needs ANTHROPIC_API_KEY). Returns null on any problem. */
export async function aiAnswer(siteId, history, instructions) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const kb = db.prepare('SELECT question, answer FROM kb WHERE site_id=?').all(siteId).map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n');
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
