/**
 * Inbound email parsing, dependency-free. Turns whatever an email provider POSTs into one normalised shape:
 *   { fromEmail, fromName, to, subject, text, html, messageId, inReplyTo, references[], autoSubmitted, attachments[{name,type,data(base64)}] }
 * Supported: raw MIME (message/rfc822 — Cloudflare Email Workers, forwarding scripts), Postmark JSON, Mailgun and
 * SendGrid Inbound Parse (multipart/form-data or urlencoded), and a simple generic JSON format.
 */

// ---------- encodings ----------
const decoderFor = cs => { try { return new TextDecoder(String(cs || 'utf-8').toLowerCase().replace(/^us-ascii$/, 'utf-8')); } catch { return new TextDecoder('utf-8'); } };
function qp(s) { // quoted-printable → bytes
  const out = []; s = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else { const b = Buffer.from(s[i], 'latin1'); out.push(...b); }
  }
  return Buffer.from(out);
}
/** RFC 2047 encoded words: =?UTF-8?B?...?= / =?ISO-8859-1?Q?...?= */
export function decodeWords(s) {
  return String(s || '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    const bytes = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : qp(txt.replace(/_/g, ' '));
    return decoderFor(cs).decode(bytes);
  });
}
const decodeBody = (raw, cte, charset) => {
  const enc = String(cte || '').toLowerCase().trim();
  const bytes = enc === 'base64' ? Buffer.from(raw.replace(/\s+/g, ''), 'base64') : enc === 'quoted-printable' ? qp(raw) : Buffer.from(raw, 'latin1');
  return { bytes, text: () => decoderFor(charset).decode(bytes) };
};

// ---------- headers ----------
/** Parses a header block into a Map(lowercase name → [values]) with folded lines joined. */
export function parseHeaders(block) {
  const map = new Map();
  for (const line of String(block).replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n')) {
    const i = line.indexOf(':'); if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (!map.has(k)) map.set(k, []); map.get(k).push(v);
  }
  return map;
}
const h1 = (map, k) => map.get(k)?.[0] || '';
/** "Name <a@b>" → { name, email } */
export function parseAddress(v) {
  const s = decodeWords(v).trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  const e = (s.match(/[^\s<>,;"]+@[^\s<>,;"]+/) || [''])[0];
  return { name: '', email: e.toLowerCase() };
}
const param = (v, p) => { const m = String(v || '').match(new RegExp(`${p}\\*?=(?:"([^"]*)"|([^;\\s]*))`, 'i')); return m ? decodeWords(m[1] ?? m[2]) : ''; };
const ids = v => String(v || '').match(/<[^<>\s]+>/g) || [];

// ---------- raw MIME ----------
/** Splits a MIME entity into headers + body and walks multiparts, collecting text, html and attachments. */
function walk(raw, acc, depth = 0) {
  const sep = raw.search(/\r?\n\r?\n/);
  const head = sep < 0 ? raw : raw.slice(0, sep), body = sep < 0 ? '' : raw.slice(sep).replace(/^\r?\n\r?\n/, '');
  const hs = parseHeaders(head), ct = h1(hs, 'content-type') || 'text/plain', type = ct.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/') && depth < 8) {
    const b = param(ct, 'boundary'); if (!b) return hs;
    const parts = body.split(new RegExp(`\\r?\\n?--${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    for (const p of parts.slice(1)) if (p.trim()) walk(p, acc, depth + 1);
    return hs;
  }
  if (type === 'message/rfc822' && depth < 8) { walk(body, acc, depth + 1); return hs; }
  const disp = h1(hs, 'content-disposition'), filename = param(disp, 'filename') || param(ct, 'name');
  const dec = decodeBody(body, h1(hs, 'content-transfer-encoding'), param(ct, 'charset'));
  if (filename || /^attachment/i.test(disp)) acc.attachments.push({ name: filename || 'attachment', type, data: dec.bytes.toString('base64') });
  else if (type === 'text/plain' && !acc.text) acc.text = dec.text();
  else if (type === 'text/html' && !acc.html) acc.html = dec.text();
  return hs;
}
export function parseMime(raw) {
  const acc = { text: '', html: '', attachments: [] };
  const hs = walk(String(raw), acc);
  return fromHeaders(hs, acc);
}
function fromHeaders(hs, acc) {
  const from = parseAddress(h1(hs, 'from'));
  const auto = h1(hs, 'auto-submitted'), prec = h1(hs, 'precedence').toLowerCase();
  return { fromEmail: from.email, fromName: from.name, to: decodeWords(h1(hs, 'to')), subject: decodeWords(h1(hs, 'subject')), text: acc.text, html: acc.html,
    messageId: ids(h1(hs, 'message-id'))[0] || '', inReplyTo: ids(h1(hs, 'in-reply-to'))[0] || '', references: ids(h1(hs, 'references')),
    autoSubmitted: (auto && auto.toLowerCase() !== 'no') || ['bulk', 'auto_reply', 'junk', 'list'].includes(prec) || hs.has('x-autoreply') || hs.has('x-autorespond'),
    attachments: acc.attachments };
}

// ---------- form posts ----------
/** multipart/form-data → { fields: {name: string}, files: [{field, name, type, data}] } */
export function parseMultipart(buf, contentType) {
  const b = param(contentType, 'boundary'), out = { fields: {}, files: [] }; if (!b) return out;
  const raw = buf.toString('latin1'), parts = raw.split('--' + b);
  for (const p of parts.slice(1)) {
    if (p.startsWith('--')) break;
    const sep = p.indexOf('\r\n\r\n'); if (sep < 0) continue;
    const hs = parseHeaders(p.slice(0, sep)), body = p.slice(sep + 4).replace(/\r\n$/, '');
    const disp = h1(hs, 'content-disposition'), name = param(disp, 'name'), filename = param(disp, 'filename');
    if (!name) continue;
    if (filename) out.files.push({ field: name, name: filename, type: (h1(hs, 'content-type') || 'application/octet-stream').split(';')[0], data: Buffer.from(body, 'latin1').toString('base64') });
    else out.fields[name] = Buffer.from(body, 'latin1').toString('utf8');
  }
  return out;
}

// ---------- providers ----------
function fromPostmark(j) {
  const hs = new Map((j.Headers || []).map(x => [String(x.Name).toLowerCase(), [x.Value]]));
  const from = j.FromFull?.Email ? { email: j.FromFull.Email.toLowerCase(), name: j.FromFull.Name || '' } : parseAddress(j.From);
  const auto = h1(hs, 'auto-submitted');
  return { fromEmail: from.email, fromName: from.name || j.FromName || '', to: j.To || '', subject: j.Subject || '', text: j.StrippedTextReply || j.TextBody || '', html: j.HtmlBody || '',
    messageId: ids(h1(hs, 'message-id'))[0] || (j.MessageID ? `<${j.MessageID}>` : ''), inReplyTo: ids(h1(hs, 'in-reply-to'))[0] || '', references: ids(h1(hs, 'references')),
    autoSubmitted: !!(auto && auto.toLowerCase() !== 'no'), attachments: (j.Attachments || []).map(a => ({ name: a.Name, type: a.ContentType, data: a.Content })) };
}
function fromForm(f, files) {
  if (f['body-plain'] != null || f.sender) { // Mailgun
    const hs = new Map((() => { try { return JSON.parse(f['message-headers'] || '[]'); } catch { return []; } })().map(([k, v]) => [String(k).toLowerCase(), [v]]));
    const from = parseAddress(f.from || f.sender);
    return { fromEmail: from.email, fromName: from.name, to: f.recipient || f.To || '', subject: f.subject || '', text: f['stripped-text'] || f['body-plain'] || '', html: f['body-html'] || '',
      messageId: ids(f['Message-Id'] || h1(hs, 'message-id'))[0] || '', inReplyTo: ids(f['In-Reply-To'] || h1(hs, 'in-reply-to'))[0] || '', references: ids(f.References || h1(hs, 'references')),
      autoSubmitted: !!(h1(hs, 'auto-submitted') && h1(hs, 'auto-submitted').toLowerCase() !== 'no'), attachments: files };
  }
  if (f.email) return parseMime(f.email); // SendGrid "post the raw, full MIME message"
  const hs = parseHeaders(f.headers || ''), from = parseAddress(f.from); // SendGrid default
  return { ...fromHeaders(hs, { text: f.text || '', html: f.html || '', attachments: files }), fromEmail: from.email, fromName: from.name, subject: f.subject || h1(hs, 'subject'), to: f.to || '' };
}
function fromGeneric(j) {
  const from = j.from && typeof j.from === 'object' ? { email: String(j.from.email || '').toLowerCase(), name: j.from.name || '' } : parseAddress(j.from || '');
  return { fromEmail: from.email, fromName: j.from_name || from.name, to: j.to || '', subject: j.subject || '', text: j.text || '', html: j.html || '',
    messageId: ids(j.message_id)[0] || '', inReplyTo: ids(j.in_reply_to)[0] || '', references: Array.isArray(j.references) ? j.references.flatMap(ids) : ids(j.references), autoSubmitted: !!j.auto_submitted,
    attachments: (Array.isArray(j.attachments) ? j.attachments : []).map(a => ({ name: a.name, type: a.type, data: a.data })) };
}

/** Detects the payload format from the content type and shape. */
export function parseInbound(buf, contentType = '') {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('message/rfc822') || ct.startsWith('text/plain')) return parseMime(buf.toString('latin1'));
  if (ct.startsWith('multipart/form-data')) { const { fields, files } = parseMultipart(buf, contentType); return fromForm(fields, files); }
  if (ct.startsWith('application/x-www-form-urlencoded')) return fromForm(Object.fromEntries(new URLSearchParams(buf.toString())), []);
  let j; try { j = JSON.parse(buf.toString()); } catch { return null; }
  if (j && (j.FromFull || j.TextBody != null || j.MessageID)) return fromPostmark(j);
  if (j && typeof j.raw === 'string') return parseMime(j.raw);
  return j ? fromGeneric(j) : null;
}

// ---------- text helpers ----------
export const htmlToText = html => String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
/** Removes the quoted previous conversation from a reply ("On … wrote:", "-----Original Message-----", trailing "> " lines). */
export function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i.test(l) || /^(On|Le|Am|El)\s.+(wrote|écrit|schrieb|escribió):$/i.test(l) || (/^On\s.+$/i.test(l) && /wrote:$/i.test((lines[i + 1] || '').trim()))
      || /^From:\s.+$/i.test(l) && /^(Sent|Date):/i.test((lines[i + 1] || '').trim()) || /^_{10,}$/.test(l)) { end = i; break; }
  }
  const kept = lines.slice(0, end);
  while (kept.length && (/^>/.test(kept.at(-1).trim()) || !kept.at(-1).trim())) kept.pop();
  return kept.join('\n').trim();
}
