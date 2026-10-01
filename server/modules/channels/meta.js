/**
 * Meta Graph API (WhatsApp Cloud API, Messenger, Instagram messaging) without SDKs: webhook signature checks,
 * payload parsing into a common shape, and sending text, buttons, media and WhatsApp templates.
 * GRAPH_BASE_URL overrides the API host (tests); GRAPH_VERSION defaults to v21.0.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const graphBase = () => `${(process.env.GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/$/, '')}/${process.env.GRAPH_VERSION || 'v21.0'}`;
export async function graph(path, token, { method = 'GET', body } = {}) {
  const r = await fetch(graphBase() + path, { method, signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) { const e = new Error(d.error?.error_user_msg || d.error?.message || `Meta API error (HTTP ${r.status})`); e.code = d.error?.code; throw e; }
  return d;
}

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
export function validSignature(raw, header, appSecret) {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const a = Buffer.from(createHmac('sha256', appSecret).update(raw).digest('hex')), b = Buffer.from(header.slice(7));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Normalises a webhook body into
 *   { messages: [{ accountId, from, name, id, text, media?: {id?, url?, type, name}, timestamp }], statuses: [{ id, status, error? }] }
 * accountId = WhatsApp phone_number_id, or the Page / Instagram account id that received the message.
 */
export function parseWebhook(body) {
  const out = { messages: [], statuses: [] };
  for (const entry of body?.entry || []) {
    for (const ch of entry.changes || []) { // WhatsApp
      const v = ch.value || {}, accountId = v.metadata?.phone_number_id;
      const names = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        const media = m.image || m.document || m.audio || m.video || m.sticker;
        const text = m.text?.body ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.button?.text ?? media?.caption
          ?? (m.location ? `📍 ${m.location.name || ''} ${m.location.latitude},${m.location.longitude}`.trim() : null) ?? '';
        out.messages.push({ accountId, from: m.from, name: names[m.from] || null, id: m.id, timestamp: Number(m.timestamp) * 1000 || Date.now(), text,
          media: media ? { id: media.id, type: media.mime_type || m.type, name: media.filename || `${m.type}.${(media.mime_type || '').split('/')[1]?.split(';')[0] || 'bin'}` } : null, kind: m.type });
      }
      for (const s of v.statuses || []) out.statuses.push({ id: s.id, status: s.status, error: s.errors?.[0]?.title || null });
    }
    for (const ev of entry.messaging || []) { // Messenger & Instagram
      if (ev.message?.is_echo) continue;
      const accountId = ev.recipient?.id || entry.id, att = ev.message?.attachments?.[0];
      if (ev.message || ev.postback) out.messages.push({ accountId, from: ev.sender?.id, name: null, id: ev.message?.mid || `pb_${ev.timestamp}_${ev.sender?.id}`, timestamp: ev.timestamp || Date.now(),
        text: ev.message?.quick_reply?.payload && ev.message?.text ? ev.message.text : ev.message?.text ?? ev.postback?.title ?? '', media: att?.payload?.url ? { url: att.payload.url, type: att.type, name: `${att.type}` } : null, kind: att ? att.type : 'text' });
      if (ev.read || ev.delivery) for (const mid of ev.delivery?.mids || []) out.statuses.push({ id: mid, status: 'delivered' });
    }
  }
  return out;
}

const trim = (s, n) => String(s).slice(0, n);
/** Sends one outgoing message. Returns the platform's message id. */
export async function sendMessage(ch, to, { text = '', buttons = [], media = null }) {
  if (ch.type === 'whatsapp') {
    let body;
    if (media?.link) body = { type: /^image\//.test(media.type) ? 'image' : 'document', [/^image\//.test(media.type) ? 'image' : 'document']: { link: media.link, ...(/^image\//.test(media.type) ? { caption: trim(text, 1024) } : { filename: media.name }) } };
    else if (buttons.length && buttons.length <= 3) body = { type: 'interactive', interactive: { type: 'button', body: { text: trim(text || '…', 1024) }, action: { buttons: buttons.map((b, i) => ({ type: 'reply', reply: { id: `b${i}`, title: trim(b, 20) } })) } } };
    else if (buttons.length) body = { type: 'interactive', interactive: { type: 'list', body: { text: trim(text || '…', 1024) }, action: { button: 'Choose', sections: [{ title: 'Options', rows: buttons.slice(0, 10).map((b, i) => ({ id: `b${i}`, title: trim(b, 24) })) }] } } };
    else body = { type: 'text', text: { body: trim(text, 4096), preview_url: true } };
    const d = await graph(`/${ch.account_id}/messages`, ch.token, { method: 'POST', body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...body } });
    return d.messages?.[0]?.id;
  }
  // Messenger & Instagram (Send API through the Page)
  const message = media?.link ? { attachment: { type: /^image\//.test(media.type) ? 'image' : 'file', payload: { url: media.link, is_reusable: false } } }
    : { text: trim(text || '…', 2000), ...(buttons.length && { quick_replies: buttons.slice(0, 13).map(b => ({ content_type: 'text', title: trim(b, 20), payload: trim(b, 1000) })) }) };
  const d = await graph(`/${ch.page_id || ch.account_id}/messages`, ch.token, { method: 'POST', body: { recipient: { id: to }, messaging_type: 'RESPONSE', message } });
  return d.message_id;
}
/** WhatsApp template message (needed outside the 24-hour customer service window). */
export async function sendTemplate(ch, to, { name, language = 'en', params = [] }) {
  const d = await graph(`/${ch.account_id}/messages`, ch.token, { method: 'POST', body: { messaging_product: 'whatsapp', to, type: 'template',
    template: { name, language: { code: language }, ...(params.length && { components: [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }] }) } } });
  return d.messages?.[0]?.id;
}
/** Downloads inbound media: WhatsApp gives a media id (two calls), Messenger/Instagram a direct URL. */
export async function fetchMedia(ch, media) {
  let url = media.url, auth = {};
  if (media.id) { url = (await graph(`/${media.id}`, ch.token)).url; auth = { Authorization: `Bearer ${ch.token}` }; }
  const base = process.env.GRAPH_BASE_URL; if (base && url && !/^https?:/.test(url)) url = base.replace(/\/$/, '') + url;
  const r = await fetch(url, { headers: auth, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error('media download failed');
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 3_000_000) throw new Error('media too large');
  return { type: (r.headers.get('content-type') || media.type || '').split(';')[0], data: buf.toString('base64'), name: media.name };
}
