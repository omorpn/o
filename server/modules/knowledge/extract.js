/**
 * Turning documents into searchable text, dependency-free: HTML pages (title, main text, links), PDFs (text operators
 * in Flate-compressed content streams, with ToUnicode maps), CSV (FAQ pairs or one row per record), plain text and
 * Markdown. Everything ends up as ~1 000-character chunks with a title and a source URL.
 */
import { inflateSync } from 'node:zlib';

// ---------- HTML ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', naira: '₦', euro: '€', pound: '£' };
export const decodeEntities = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|css|js|json|xml|zip|gz|mp4|mp3|webm|woff2?|ttf|pdf|docx?|xlsx?|pptx?)(\?|$)/i;

/** @returns {{ title: string, text: string, links: string[] }} */
export function htmlToDoc(html, baseUrl) {
  let s = String(html);
  const title = decodeEntities((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const desc = decodeEntities(s.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || '');
  const links = [];
  for (const m of s.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)(?:#[^"']*)?["']/gi)) {
    try { const u = new URL(decodeEntities(m[1]), baseUrl); if (/^https?:$/.test(u.protocol) && !SKIP_EXT.test(u.pathname)) { u.hash = ''; links.push(u.href); } } catch { /* bad href */ }
  }
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe|form|nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = s.match(/<main\b[\s\S]*?<\/main>/i)?.[0] || s.match(/<article\b[\s\S]*?<\/article>/i)?.[0] || s.match(/<body\b[\s\S]*<\/body>/i)?.[0] || s;
  const text = decodeEntities(main.replace(/<(br|hr)\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|dd|dt|table)>/gi, '\n').replace(/<h[1-6][^>]*>/gi, '\n## ').replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<t[dh][^>]*>/gi, ' | ').replace(/<[^>]+>/g, ' ')).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: desc && !text.includes(desc) ? `${desc}\n\n${text}` : text, links: [...new Set(links)] };
}
/** <loc> entries of a sitemap (or sitemap index). */
export const sitemapUrls = xml => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decodeEntities(m[1]));
/** Disallow prefixes for "User-agent: *" (and ChatlyBot). */
export function robotsRules(txt) {
  const out = []; let applies = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); const [k, ...v] = line.split(':'); const val = v.join(':').trim();
    if (/^user-agent$/i.test(k)) applies = val === '*' || /chatly/i.test(val);
    else if (applies && /^disallow$/i.test(k) && val) out.push(val);
  }
  return out;
}

// ---------- PDF ----------
function pdfString(lit) { // literal string body (without parentheses) → bytes
  const out = [];
  for (let i = 0; i < lit.length; i++) {
    const c = lit[i];
    if (c !== '\\') { out.push(lit.charCodeAt(i) & 255); continue; }
    const n = lit[++i];
    if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(lit[i + 1])) o += lit[++i]; out.push(parseInt(o, 8) & 255); }
    else if (n === '\n' || n === '\r') { if (n === '\r' && lit[i + 1] === '\n') i++; }
    else out.push({ n: 10, r: 13, t: 9, b: 8, f: 12 }[n] ?? n.charCodeAt(0));
  }
  return out;
}
function parseCmap(txt, map) {
  const hex = h => parseInt(h, 16), uni = h => { let s = ''; for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(hex(h.slice(i, i + 4))); return s; };
  for (const block of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(m[1].toLowerCase().padStart(4, '0'), uni(m[2]));
  for (const block of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const a = hex(m[1]), b = Math.min(hex(m[2]), a + 5000);
      if (m[4]) { const base = hex(m[4]); for (let c = a; c <= b; c++) map.set(c.toString(16).padStart(4, '0'), String.fromCodePoint(base + c - a)); }
      else [...m[5].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((x, k) => map.set((a + k).toString(16).padStart(4, '0'), uni(x[1])));
    }
  }
}
/** Best-effort text from a PDF buffer. Scanned (image-only) PDFs yield no text. */
export function pdfText(buf) {
  const s = buf.toString('latin1'), streams = [], cmap = new Map();
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length, end = s.indexOf('endstream', start); if (end < 0) continue;
    const dict = s.slice(Math.max(0, s.lastIndexOf('obj', m.index)), m.index);
    if (/\/Subtype\s*\/Image|\/Length1|\/FontFile/.test(dict)) continue;
    let data = Buffer.from(s.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
    if (/\/FlateDecode/.test(dict)) { try { data = inflateSync(data); } catch { continue; } } else if (/\/Filter/.test(dict)) continue;
    const txt = data.toString('latin1');
    if (txt.includes('begincmap')) parseCmap(txt, cmap); else if (/\bBT\b/.test(txt)) streams.push(txt);
  }
  const decodeHex = h => {
    h = h.replace(/\s+/g, ''); if (h.length % 2) h += '0';
    if (cmap.size && h.length % 4 === 0) { let o = ''; for (let i = 0; i < h.length; i += 4) o += cmap.get(h.slice(i, i + 4).toLowerCase()) ?? ''; if (o) return o; }
    return Buffer.from(h, 'hex').toString('latin1');
  };
  const decodeLit = lit => { const bytes = pdfString(lit); return cmap.size && [...cmap.keys()].some(k => k.startsWith('00')) ? bytes.map(b => cmap.get(b.toString(16).padStart(4, '0')) ?? String.fromCharCode(b)).join('') : Buffer.from(bytes).toString('latin1'); };
  const out = [];
  const TOKEN = /\[((?:\((?:[^()\\]|\\[\s\S]|\((?:[^()\\]|\\[\s\S])*\))*\)|<[0-9A-Fa-f\s]*>|[^\]])*)\]\s*TJ|\(((?:[^()\\]|\\[\s\S]|\((?:[^()\\]|\\[\s\S])*\))*)\)\s*(?:Tj|'|")|<([0-9A-Fa-f\s]*)>\s*(?:Tj|'|")|\b(T\*|Td|TD|ET)\b/g;
  for (const st of streams) {
    let line = '';
    for (const m of st.matchAll(TOKEN)) {
      if (m[4]) { if (line.trim()) out.push(line.trim()); line = ''; continue; }
      if (m[2] != null) line += decodeLit(m[2]);
      else if (m[3] != null) line += decodeHex(m[3]);
      else for (const p of m[1].matchAll(/\(((?:[^()\\]|\\[\s\S]|\((?:[^()\\]|\\[\s\S])*\))*)\)|<([0-9A-Fa-f\s]*)>|(-?\d+(?:\.\d+)?)/g)) {
        if (p[1] != null) line += decodeLit(p[1]); else if (p[2] != null) line += decodeHex(p[2]); else if (Number(p[3]) < -180) line += ' ';
      }
    }
    if (line.trim()) out.push(line.trim());
  }
  return out.join('\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- CSV ----------
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false; const s = String(text).replace(/^﻿/, '');
  const sep = (s.split('\n')[0].match(/;/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
/** CSV → chunks: question/answer columns become FAQ entries; other tables become one record per row. */
export function csvChunks(text, name) {
  const rows = parseCsv(text).slice(0, 5001); if (rows.length < 2) return [];
  const head = rows[0].map(x => x.trim()), lower = head.map(x => x.toLowerCase());
  const qi = lower.findIndex(x => /^(q|question|questions|faq|query)$/.test(x)), ai = lower.findIndex(x => /^(a|answer|answers|reply|response)$/.test(x));
  if (qi >= 0 && ai >= 0) return rows.slice(1).filter(r => r[qi]?.trim() && r[ai]?.trim()).map(r => ({ title: r[qi].trim().slice(0, 200), content: `Q: ${r[qi].trim()}\nA: ${r[ai].trim()}` }));
  return rows.slice(1).map(r => ({ title: `${name}: ${(r[0] || '').trim()}`.slice(0, 200), content: head.map((h, i) => r[i]?.trim() ? `${h || 'Column ' + (i + 1)}: ${r[i].trim()}` : null).filter(Boolean).join('\n') })).filter(c => c.content);
}

// ---------- chunking ----------
/** Splits long text into ~`size`-character chunks on paragraph, then sentence boundaries. */
export function chunkText(text, size = 1000) {
  const paras = String(text).split(/\n{2,}/).map(p => p.trim()).filter(Boolean), out = []; let cur = '';
  const push = () => { if (cur.trim().length > 30) out.push(cur.trim()); cur = ''; };
  for (const p of paras) {
    if (p.length > size) { push(); let part = ''; for (const s of p.split(/(?<=[.!?])\s+/)) { if (part.length + s.length > size && part) { out.push(part.trim()); part = ''; } part += s + ' '; } if (part.trim().length > 30) out.push(part.trim()); continue; }
    if (cur.length + p.length > size) push();
    cur += p + '\n\n';
  }
  push();
  return out;
}
