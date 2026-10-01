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

/**
 * AI answer via the Claude API (needs ANTHROPIC_API_KEY). Grounded in the Q&A knowledge base plus `passages`
 * retrieved from the website's knowledge sources. Returns { text, sources } or null when the model is unsure
 * (it answers HANDOFF), the key is missing or the call fails.
 */
export async function aiAnswer(siteId, history, instructions, passages = []) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const kb = db.prepare('SELECT question, answer FROM kb WHERE site_id=? LIMIT 60').all(siteId).map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n');
  const docs = passages.map((p, i) => `[${i + 1}] ${p.title || ''}${p.url ? ` (${p.url})` : ''}\n${p.content}`).join('\n\n');
  const system = `${instructions}

Answer ONLY using the knowledge below. Be concise and friendly; answer in the visitor's language. Never invent prices, policies, links or facts.
If the answer is not in the knowledge, or the visitor asks for a person, reply exactly: HANDOFF
If you used numbered documents, end with a last line "SOURCES: " followed by their numbers, e.g. "SOURCES: 1,3".

Q&A knowledge base:
${kb || '(empty)'}

Documents:
${docs || '(none)'}`;
  try {
    const r = await fetch(`${(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 500, system, messages: history }),
    });
    if (!r.ok) return null;
    const d = await r.json(); let t = (d.content?.find(c => c.type === 'text')?.text || '').trim();
    if (!t || /^HANDOFF\b/.test(t)) return null;
    const m = t.match(/\n?SOURCES:\s*([\d,\s]+)\s*$/i), used = m ? [...new Set(m[1].split(/[,\s]+/).map(Number).filter(n => n >= 1 && n <= passages.length))] : [];
    if (m) t = t.slice(0, m.index).trim();
    return { text: t, sources: used.map(n => ({ title: passages[n - 1].title, url: passages[n - 1].url })) };
  } catch { return null; }
}
