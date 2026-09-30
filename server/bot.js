import { db } from './db.js';

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const HUMAN_PHRASE = 'talk to a human';

export function parseRule(r) {
  return { ...r, buttons: JSON.parse(r.buttons || '[]'), handoff: !!r.handoff, enabled: !!r.enabled };
}

/** Returns the best matching enabled rule for a message, or null. */
export function matchRule(text) {
  const t = text.toLowerCase().trim();
  if (!t) return null;
  let best = null, bestScore = 0;
  for (const raw of db.prepare('SELECT * FROM rules WHERE enabled=1 ORDER BY position, id').all()) {
    let score = 0;
    for (const kw of raw.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)) {
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc(kw)}($|[^\\p{L}\\p{N}])`, 'u').test(t)) score += kw.length;
    }
    if (score > bestScore) { best = raw; bestScore = score; }
  }
  return best ? parseRule(best) : null;
}
