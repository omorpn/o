/**
 * Knowledge store: sources (websites, sitemaps, files, pasted text) → chunks in an FTS5 index (BM25 ranking, Porter
 * stemming). Also the safe crawler (public addresses only, robots.txt, same host, page/size limits), retrieval for
 * the AI, extractive answers when no AI key is configured, missed-question tracking and the answer log.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { db, now } from '../../core/db.js';
import { emit } from '../../core/events.js';
import { htmlToDoc, sitemapUrls, robotsRules, pdfText, csvChunks, chunkText } from './extract.js';

db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, type TEXT NOT NULL, name TEXT NOT NULL, url TEXT,
  max_pages INTEGER NOT NULL DEFAULT 30, status TEXT NOT NULL DEFAULT 'pending', error TEXT, pages INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0,
  raw TEXT, last_synced INTEGER, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE, site_id INTEGER NOT NULL, title TEXT, url TEXT, content TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_kchunks_source ON knowledge_chunks(source_id);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(title, content, content='knowledge_chunks', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS kchunks_ai AFTER INSERT ON knowledge_chunks BEGIN INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END;
CREATE TRIGGER IF NOT EXISTS kchunks_ad AFTER DELETE ON knowledge_chunks BEGIN INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); END;
CREATE TABLE IF NOT EXISTS missed_questions (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, conv_id INTEGER, question TEXT NOT NULL, norm TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open', kb_id INTEGER, created INTEGER NOT NULL, last_asked INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_missed_site ON missed_questions(site_id, status, last_asked);
CREATE TABLE IF NOT EXISTS ai_answers (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, conv_id INTEGER, question TEXT NOT NULL, answer TEXT, mode TEXT NOT NULL,
  sources TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ai_answers_site ON ai_answers(site_id, created);
`);

export const LIMITS = { sourcesPerSite: 50, chunksPerSite: 8000, maxPages: 200, pageBytes: 3_000_000, fileBytes: 10_000_000 };

// ---------- safe fetching ----------
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./, /^22[4-9]\.|^2[3-5]\d\./, /^::1$/, /^f[cd]/i, /^fe80/i, /^::ffff:(127|10|192\.168|169\.254)\./i, /^::$/];
/** Refuses URLs that resolve to loopback, private, link-local or multicast addresses (SSRF protection). */
export async function assertPublic(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs can be added');
  if (process.env.ALLOW_PRIVATE_CRAWL === '1') return u;
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) throw new Error('That address is not reachable from the internet');
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true }).catch(() => { throw new Error(`Could not find ${u.hostname}`); });
  if (addrs.some(a => PRIVATE.some(re => re.test(a.address)))) throw new Error('That address points to a private network');
  return u;
}
/** GET with manual redirects (each hop re-checked), timeout and size cap. */
export async function safeFetch(url, { maxBytes = LIMITS.pageBytes, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5' } = {}) {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(cur);
    const r = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'ChatlyBot/1.0 (+knowledge crawler)', Accept: accept } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { cur = new URL(r.headers.get('location'), cur).href; continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const len = Number(r.headers.get('content-length') || 0); if (len > maxBytes) throw new Error('Page too large');
    const chunks = []; let size = 0;
    for await (const c of r.body) { size += c.length; if (size > maxBytes) throw new Error('Page too large'); chunks.push(c); }
    return { url: cur, type: r.headers.get('content-type') || '', body: Buffer.concat(chunks) };
  }
  throw new Error('Too many redirects');
}

// ---------- indexing ----------
const insertChunk = db.prepare('INSERT INTO knowledge_chunks(source_id,site_id,title,url,content) VALUES(?,?,?,?,?)');
function replaceChunks(src, docs) {
  const room = LIMITS.chunksPerSite - db.prepare('SELECT COUNT(*) n FROM knowledge_chunks WHERE site_id=? AND source_id!=?').get(src.site_id, src.id).n;
  let n = 0;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM knowledge_chunks WHERE source_id=?').run(src.id);
    for (const d of docs) for (const c of d.chunks) { if (n >= room) break; insertChunk.run(src.id, src.site_id, d.title || src.name, d.url || null, c); n++; }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}
const setStatus = (id, fields) => db.prepare(`UPDATE knowledge_sources SET ${Object.keys(fields).map(k => k + '=?').join(', ')} WHERE id=?`).run(...Object.values(fields), id);
const sameSite = (a, b) => a.replace(/^www\./, '') === b.replace(/^www\./, '');

async function crawl(src) {
  const start = new URL(src.url), max = Math.min(src.max_pages || 30, LIMITS.maxPages);
  let disallow = [];
  try { const r = await safeFetch(new URL('/robots.txt', start).href, { maxBytes: 200_000, accept: 'text/plain' }); disallow = robotsRules(r.body.toString()); } catch { /* no robots.txt */ }
  const allowed = u => !disallow.some(p => u.pathname.startsWith(p));
  let queue = [start.href];
  if (src.type === 'sitemap' || /sitemap[^/]*\.xml$/i.test(start.pathname)) {
    const r = await safeFetch(start.href, { accept: 'application/xml,text/xml' });
    let locs = sitemapUrls(r.body.toString());
    const nested = locs.filter(l => /\.xml(\?|$)/i.test(l)).slice(0, 10);
    for (const n of nested) { try { locs.push(...sitemapUrls((await safeFetch(n, { accept: 'application/xml' })).body.toString())); } catch { /* skip */ } }
    queue = locs.filter(l => !/\.xml(\?|$)/i.test(l));
  }
  const seen = new Set(), docs = []; let errors = 0;
  while (queue.length && docs.length < max) {
    const url = queue.shift(); let u; try { u = new URL(url); } catch { continue; }
    const key = u.origin + u.pathname.replace(/\/$/, '') + u.search; if (seen.has(key)) continue; seen.add(key);
    if (!sameSite(u.hostname, start.hostname) || !allowed(u)) continue;
    try {
      const r = await safeFetch(u.href);
      if (!/html/i.test(r.type)) continue;
      const doc = htmlToDoc(r.body.toString('utf8'), r.url);
      if (doc.text.length > 80) docs.push({ title: doc.title || u.pathname, url: r.url, chunks: chunkText(doc.text) });
      if (src.type === 'url') for (const l of doc.links) if (!seen.has(l.replace(/\/$/, ''))) queue.push(l);
    } catch (e) { errors++; if (u.href === start.href && !docs.length) throw e; }
  }
  return { docs, errors };
}

/** (Re)builds a source's chunks. Runs in the background for websites; never throws. */
export async function syncSource(id) {
  const src = db.prepare('SELECT * FROM knowledge_sources WHERE id=?').get(id); if (!src) return;
  setStatus(id, { status: 'indexing', error: null });
  try {
    let docs, pages = 1, errors = 0;
    if (src.type === 'url' || src.type === 'sitemap') ({ docs, errors } = await crawl(src)), pages = docs.length;
    else if (src.type === 'text') docs = [{ title: src.name, chunks: chunkText(src.raw || '') }];
    else if (src.type === 'pdf') { const txt = pdfText(Buffer.from(src.raw || '', 'base64')); if (!txt.trim()) throw new Error('No text found in this PDF (scanned PDFs need OCR first)'); docs = [{ title: src.name, chunks: chunkText(txt) }]; }
    else if (src.type === 'csv') docs = csvChunks(Buffer.from(src.raw || '', 'base64').toString('utf8'), src.name).map(c => ({ title: c.title, chunks: chunkText(c.content, 1500) }));
    else docs = [{ title: src.name, chunks: chunkText(Buffer.from(src.raw || '', 'base64').toString('utf8')) }];
    const n = replaceChunks(src, docs);
    if (!n) throw new Error(src.type === 'url' || src.type === 'sitemap' ? 'No readable pages found' : 'No text found');
    setStatus(id, { status: 'ready', pages, chunks: n, last_synced: now(), error: errors ? `${errors} page(s) could not be read` : null });
  } catch (e) {
    setStatus(id, { status: 'error', error: String(e.message || e).slice(0, 300), last_synced: now() });
  }
  emit('knowledge.synced', { sourceId: id, siteId: src.site_id });
}

// ---------- retrieval ----------
const STOP = new Set('the a an is are was were be been do does did you your i me my we our us to of and or for in on at by with from this that these those it its what how can could would should will when where which who why there here about into have has had not no yes please hi hello thanks thank'.split(' '));
export const terms = q => [...new Set(String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1 && !STOP.has(w)))].slice(0, 20);
const stem = w => w.length > 5 ? w.slice(0, w.length - 2) : w.length > 3 ? w.slice(0, w.length - 1) : w;

/** Top chunks for a question, each with `coverage` = share of the question's terms found in it. */
export function search(siteId, question, k = 6) {
  const t = terms(question); if (!t.length) return [];
  const match = t.map(w => `"${w.replace(/"/g, '')}"*`).join(' OR ');
  let rows;
  try {
    rows = db.prepare(`SELECT c.id, c.title, c.url, c.content, c.source_id, bm25(knowledge_fts, 3.0, 1.0) score FROM knowledge_fts JOIN knowledge_chunks c ON c.id=knowledge_fts.rowid
      WHERE knowledge_fts MATCH ? AND c.site_id=? ORDER BY score LIMIT ?`).all(match, siteId, k * 3);
  } catch { return []; }
  return rows.map(r => { const hay = (r.title + ' ' + r.content).toLowerCase(); return { ...r, coverage: t.filter(w => hay.includes(stem(w))).length / t.length }; })
    .sort((a, b) => b.coverage - a.coverage || a.score - b.score).slice(0, k);
}

/** Answer quoted from the best passage (used when no AI model is configured). */
export function extractiveAnswer(siteId, question) {
  const hits = search(siteId, question, 3), best = hits[0], t = terms(question);
  if (!best || best.coverage < (t.length <= 2 ? 1 : 0.6)) return null;
  const faq = best.content.match(/^Q: [\s\S]*?\nA: ([\s\S]+)$/); // FAQ entries (CSV) answer with their answer
  if (faq) return { text: faq[1].trim().slice(0, 1200), sources: [{ title: best.title, url: best.url }] };
  const sentences = best.content.split(/(?<=[.!?])\s+|\n+/).map(s => s.replace(/^[#•\s]+/, '').trim()).filter(s => s.length > 15);
  if (!sentences.length) return null;
  const scored = sentences.map((s, i) => ({ i, n: t.filter(w => s.toLowerCase().includes(stem(w))).length })).sort((a, b) => b.n - a.n || a.i - b.i);
  const i = scored[0].i, text = [sentences[i], sentences[i + 1]].filter(Boolean).join(' ').slice(0, 450);
  return { text, sources: [{ title: best.title, url: best.url }] };
}

// ---------- missed questions & answer log ----------
const normQ = q => terms(q).sort().join(' ');
export function recordMissed(siteId, convId, question) {
  const q = String(question).trim().slice(0, 500); if (q.length < 4 || terms(q).length < 1) return;
  const norm = normQ(q), ex = db.prepare("SELECT id FROM missed_questions WHERE site_id=? AND norm=? AND status='open'").get(siteId, norm);
  if (ex) db.prepare('UPDATE missed_questions SET count=count+1, last_asked=?, conv_id=? WHERE id=?').run(now(), convId, ex.id);
  else db.prepare('INSERT INTO missed_questions(site_id,conv_id,question,norm,created,last_asked) VALUES(?,?,?,?,?,?)').run(siteId, convId, q, norm, now(), now());
}
export function logAnswer(siteId, convId, question, answer, mode, sources) {
  db.prepare('INSERT INTO ai_answers(site_id,conv_id,question,answer,mode,sources,created) VALUES(?,?,?,?,?,?,?)').run(siteId, convId, String(question).slice(0, 1000), answer, mode, sources?.length ? JSON.stringify(sources) : null, now());
}
/** "Source: …" footer for bot replies. */
export const sourceLine = sources => {
  const s = (sources || []).filter(x => x.url).slice(0, 2);
  return s.length ? `\n\nSource: ${s.map(x => x.url).join(' · ')}` : '';
};
