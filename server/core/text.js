/** Small text-matching helpers shared by automation modules. */
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function keywordScore(text, keywords) {
  const t = text.toLowerCase().trim(); let score = 0;
  for (const kw of keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)) {
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc(kw)}(?:s|es)?($|[^\\p{L}\\p{N}])`, 'u').test(t)) score += kw.length;
  }
  return score;
}
