/**
 * Email channel. Each workspace connects one or more support mailboxes (support@yourshop.com). Customers' emails
 * reach Chatly through the mailbox's private inbound URL — set it as the destination in Postmark, Mailgun or
 * SendGrid inbound routing, a Cloudflare Email Worker, or any forwarder that POSTs raw MIME — and become tickets.
 *
 * Threading: replies are matched to their ticket by In-Reply-To / References (every email we send carries a
 * Message-ID we store), then by the "[#123]" token in the subject from the same requester. Replies reopen
 * pending/solved tickets; a reply to a closed ticket starts a follow-up ticket. Agent replies go out by SMTP with
 * the mailbox's name, signature and Reply-To so the conversation continues by email.
 */
import { randomBytes } from 'node:crypto';
import { db, now } from '../../core/db.js';
import { fail, str, EMAIL, limit } from '../../core/http.js';
import { on } from '../../core/events.js';
import { defineModule, isEnabled } from '../../core/modules.js';
import { sendMail, mailConfigured } from '../../core/mail.js';
import * as fraud from '../fraud/engine.js';
import { saveUpload, validDepartment } from '../livechat/service.js';
import { getTicket, createTicket, addTicketMessage, updateTicket, logEvent, PRIORITIES } from '../tickets/service.js';
import { parseInbound, htmlToText, stripQuoted } from './parse.js';

db.exec(`
CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, address TEXT NOT NULL,
  inbound_token TEXT NOT NULL UNIQUE, from_name TEXT, signature TEXT, department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'normal', auto_reply INTEGER NOT NULL DEFAULT 1, auto_reply_text TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  received INTEGER NOT NULL DEFAULT 0, last_received INTEGER, last_error TEXT, created INTEGER NOT NULL, UNIQUE(workspace_id, address));
`);
try { db.exec('ALTER TABLE tickets ADD COLUMN mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL'); } catch { /* exists */ }

const DEFAULT_AUTO_REPLY = 'Hi {name},\n\nThanks for contacting us — we received your message and opened request #{number}: "{subject}".\nOur team will get back to you as soon as possible. Just reply to this email to add more details.';
const token = () => randomBytes(18).toString('hex');
const ourAddress = () => ((process.env.SMTP_FROM || '').match(/[^\s<>]+@[^\s<>]+/) || [''])[0].toLowerCase();
const mailDomain = () => ourAddress().split('@')[1] || 'chatly.local';
const baseSubject = s => String(s || '').replace(/\s*\[#\d+\]\s*/g, ' ').replace(/^\s*((re|fw|fwd|aw|sv|tr)\s*:\s*)+/i, '').trim();
const fill = (tpl, t) => tpl.replace(/\{number\}/g, t.number).replace(/\{subject\}/g, t.subject).replace(/\{name\}/g, t.requester_name || 'there');
const wsName = ws => db.prepare('SELECT name FROM workspaces WHERE id=?').get(ws)?.name || 'Support';
const logMail = (mb, err) => db.prepare('UPDATE mailboxes SET last_error=? WHERE id=?').run(err ? String(err).slice(0, 300) : null, mb.id);

async function saveAttachments(list) {
  const out = [];
  for (const a of (list || []).slice(0, 5)) {
    try { out.push(await saveUpload({ type: String(a.type || '').toLowerCase(), data: a.data, name: a.name })); } catch { /* unsupported or too large: skipped */ }
  }
  return out;
}

/**
 * Files one inbound email. Returns { action: 'created'|'replied'|'followup'|'ignored', ticket?, reason? }.
 * Never throws for bad mail — providers retry on errors, so problems are answered with "ignored".
 */
export async function receiveEmail(mb, mail) {
  const ws = mb.workspace_id, from = mail?.fromEmail;
  if (!mail || !from || !EMAIL.test(from)) return { action: 'ignored', reason: 'no sender' };
  if (from === mb.address || from === ourAddress()) return { action: 'ignored', reason: 'loop: sent by us' };
  if (fraud.isBlocked('email', from, ws) || fraud.isBlocked('domain', from.split('@')[1], ws)) return { action: 'ignored', reason: 'sender blocked' };
  try { limit(`inbound:${mb.id}:${from}`, 30, 3600_000); } catch { return { action: 'ignored', reason: 'rate limited' }; }
  if (mail.messageId && db.prepare('SELECT 1 FROM ticket_messages m JOIN tickets t ON t.id=m.ticket_id WHERE t.workspace_id=? AND m.email_message_id=?').get(ws, mail.messageId))
    return { action: 'ignored', reason: 'duplicate' };

  const full = (mail.text || htmlToText(mail.html)).trim(), body = (stripQuoted(full) || full || '(empty message)').slice(0, 20000);
  const subject = str(mail.subject, 200) || '(no subject)', name = str(mail.fromName, 100) || null;
  const attachments = await saveAttachments(mail.attachments);

  // 1) thread by message ids, 2) by [#number] token from the same requester
  const refs = [mail.inReplyTo, ...(mail.references || [])].filter(Boolean).slice(-20);
  let t = refs.length ? db.prepare(`SELECT t.* FROM ticket_messages m JOIN tickets t ON t.id=m.ticket_id WHERE t.workspace_id=? AND m.email_message_id IN (${refs.map(() => '?').join(',')}) ORDER BY m.id DESC LIMIT 1`).get(ws, ...refs) : null;
  if (!t) { const n = subject.match(/\[#(\d+)\]/); if (n) t = db.prepare('SELECT * FROM tickets WHERE workspace_id=? AND number=? AND requester_email=?').get(ws, Number(n[1]), from); }
  for (let i = 0; t?.merged_into && i < 10; i++) t = getTicket(t.merged_into);
  db.prepare('UPDATE mailboxes SET received=received+1, last_received=? WHERE id=?').run(now(), mb.id);

  if (t && mail.autoSubmitted) return { action: 'ignored', reason: 'auto-reply to an existing ticket', ticket: t }; // out-of-office etc.
  if (t && t.status !== 'closed') {
    addTicketMessage(t, { kind: 'public', authorType: 'customer', authorName: name || from, authorEmail: from, body, attachments, emailMessageId: mail.messageId || null });
    if (t.status !== 'open') updateTicket(getTicket(t.id), { status: 'open' }, null);
    return { action: 'replied', ticket: getTicket(t.id) };
  }
  const prev = t;
  const nt = createTicket({ ws, subject: baseSubject(subject) || subject, body, channel: 'email', priority: mb.priority, requesterName: name, requesterEmail: from,
    departmentId: validDepartment(ws, mb.department_id), emailMessageId: mail.messageId || null, attachments });
  db.prepare('UPDATE tickets SET mailbox_id=? WHERE id=?').run(mb.id, nt.id);
  if (prev) {
    addTicketMessage(getTicket(nt.id), { kind: 'note', authorType: 'system', authorName: 'System', body: `Follow-up to closed ticket #${prev.number} “${prev.subject}”.` });
    logEvent(prev.id, null, 'follow_up', `Customer wrote again — follow-up ticket #${nt.number}`);
  }
  if (mb.auto_reply && !mail.autoSubmitted && mailConfigured()) {
    const fresh = getTicket(nt.id), msgId = `<t${nt.id}.ack.${randomBytes(6).toString('hex')}@${mailDomain()}>`;
    sendMail({ to: from, subject: `Re: ${fresh.subject} [#${fresh.number}]`, text: fill(mb.auto_reply_text || DEFAULT_AUTO_REPLY, fresh) + (mb.signature ? `\n\n${mb.signature}` : ''),
      fromName: mb.from_name || wsName(ws), replyTo: mb.address, messageId: msgId, inReplyTo: mail.messageId || undefined, references: mail.messageId || undefined, autoReply: true })
      .then(() => { addTicketMessage(getTicket(nt.id), { kind: 'system', authorType: 'system', authorName: 'System', body: `Automatic acknowledgement sent to ${from}`, emailMessageId: msgId }); logMail(mb, null); })
      .catch(e => logMail(mb, 'Auto-reply failed: ' + e.message));
  }
  return { action: prev ? 'followup' : 'created', ticket: getTicket(nt.id) };
}

/** Emails an agent's public reply to the requester, threaded with everything sent before. */
async function sendReply(ticket, message) {
  const t = getTicket(ticket.id); if (!t?.requester_email) return;
  if (!mailConfigured()) { addTicketMessage(t, { kind: 'note', authorType: 'system', authorName: 'System', body: `⚠️ Not emailed to ${t.requester_email}: outgoing email (SMTP) is not configured on this server.` }); return; }
  const mb = (t.mailbox_id && db.prepare('SELECT * FROM mailboxes WHERE id=?').get(t.mailbox_id))
    || (isEnabled(t.workspace_id, 'email') && db.prepare('SELECT * FROM mailboxes WHERE workspace_id=? AND enabled=1 ORDER BY id LIMIT 1').get(t.workspace_id)) || null;
  const prior = db.prepare('SELECT email_message_id FROM ticket_messages WHERE ticket_id=? AND email_message_id IS NOT NULL AND id<? ORDER BY id').all(t.id, message.id).map(r => r.email_message_id);
  const msgId = `<t${t.id}.m${message.id}.${randomBytes(6).toString('hex')}@${mailDomain()}>`;
  db.prepare('UPDATE ticket_messages SET email_message_id=? WHERE id=?').run(msgId, message.id);
  const footer = `\n\n${mb?.signature ? mb.signature + '\n\n' : ''}— Request #${t.number}. Reply to this email to respond.`;
  try {
    await sendMail({ to: t.requester_email, subject: `${t.channel === 'email' ? 'Re: ' : ''}${baseSubject(t.subject)} [#${t.number}]`, text: message.body + footer,
      fromName: mb?.from_name || (message.author_name ? `${message.author_name} (${wsName(t.workspace_id)})` : wsName(t.workspace_id)), replyTo: mb?.address,
      messageId: msgId, inReplyTo: prior.at(-1), references: prior.slice(-10).join(' ') || undefined });
    if (mb) logMail(mb, null);
  } catch (e) {
    if (mb) logMail(mb, e.message);
    addTicketMessage(getTicket(t.id), { kind: 'note', authorType: 'system', authorName: 'System', body: `⚠️ Email to ${t.requester_email} could not be sent: ${e.message}` });
  }
}

// ---------- API ----------
const mbOut = (m, origin) => ({ id: m.id, name: m.name, address: m.address, from_name: m.from_name || '', signature: m.signature || '', department_id: m.department_id, priority: m.priority,
  auto_reply: !!m.auto_reply, auto_reply_text: m.auto_reply_text || DEFAULT_AUTO_REPLY, enabled: !!m.enabled, received: m.received, last_received: m.last_received, last_error: m.last_error,
  inbound_url: `${origin}/api/inbound/email/${m.inbound_token}` });
const originOf = c => (process.env.PUBLIC_URL || `${c.req.headers['x-forwarded-proto'] || 'http'}://${c.req.headers['x-forwarded-host'] || c.req.headers.host}`).replace(/\/$/, '');
const ownMb = c => db.prepare('SELECT * FROM mailboxes WHERE id=? AND workspace_id=?').get(c.int('id'), c.ws) || fail(404, 'Mailbox not found');
function mbFields(c, b, cur) {
  const name = str(b.name ?? cur?.name, 60), address = str(b.address ?? cur?.address, 200).toLowerCase();
  if (!name) fail(400, 'Give the mailbox a name'); if (!EMAIL.test(address)) fail(400, 'Enter the support email address customers write to');
  const priority = b.priority ?? cur?.priority ?? 'normal'; if (!PRIORITIES.includes(priority)) fail(400, 'Bad priority');
  const dep = 'department_id' in b ? (b.department_id == null || b.department_id === '' ? null : validDepartment(c.ws, b.department_id) || fail(400, 'Unknown department')) : cur?.department_id ?? null;
  return { name, address, from_name: str(b.from_name ?? cur?.from_name ?? '', 80) || null, signature: str(b.signature ?? cur?.signature ?? '', 1000) || null, department_id: dep, priority,
    auto_reply: ('auto_reply' in b ? !!b.auto_reply : cur ? !!cur.auto_reply : true) ? 1 : 0, auto_reply_text: str(b.auto_reply_text ?? cur?.auto_reply_text ?? '', 2000) || null,
    enabled: ('enabled' in b ? !!b.enabled : cur ? !!cur.enabled : true) ? 1 : 0 };
}

export default defineModule({
  key: 'email', name: 'Email channel', description: 'Turn emails to your support address into tickets and reply by email, with threading and auto-replies.',
  init() {
    on('ticket.message', ({ ticket, message }) => { if (message.kind === 'public' && message.author_type === 'agent') sendReply(ticket, message); });
  },
  routes: [
    { method: 'POST', path: '/api/inbound/email/:token', auth: 'public', handler: async c => {
      const mb = db.prepare('SELECT * FROM mailboxes WHERE inbound_token=?').get(c.params.token);
      if (!mb) fail(404, 'Unknown inbound address');
      limit('inbound:' + mb.id, 600, 60_000);
      const buf = await c.raw(25_000_000);
      if (!mb.enabled || !isEnabled(mb.workspace_id, 'email') || db.prepare('SELECT suspended FROM workspaces WHERE id=?').get(mb.workspace_id)?.suspended) return { ok: true, action: 'ignored', reason: 'mailbox disabled' };
      const mail = parseInbound(buf, String(c.req.headers['content-type'] || ''));
      if (!mail) { logMail(mb, 'Could not read an inbound request (unsupported format)'); fail(400, 'Unsupported inbound email format'); }
      const r = await receiveEmail(mb, mail);
      return { ok: true, action: r.action, reason: r.reason, ticket: r.ticket ? { id: r.ticket.id, number: r.ticket.number } : undefined };
    } },
    { method: 'GET', path: '/api/mailboxes', auth: 'ws', perm: ['settings.manage', 'tickets.manage'], handler: c => ({
      mailboxes: db.prepare('SELECT * FROM mailboxes WHERE workspace_id=? ORDER BY id').all(c.ws).map(m => mbOut(m, originOf(c))), smtp: mailConfigured(), sendingAddress: ourAddress() || null }) },
    { method: 'POST', path: '/api/mailboxes', auth: 'ws', perm: 'settings.manage', handler: async c => {
      const f = mbFields(c, await c.body());
      if (db.prepare('SELECT COUNT(*) n FROM mailboxes WHERE workspace_id=?').get(c.ws).n >= 20) fail(400, 'Up to 20 mailboxes per workspace');
      try {
        const id = db.prepare('INSERT INTO mailboxes(workspace_id,name,address,inbound_token,from_name,signature,department_id,priority,auto_reply,auto_reply_text,enabled,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(c.ws, f.name, f.address, token(), f.from_name, f.signature, f.department_id, f.priority, f.auto_reply, f.auto_reply_text, f.enabled, now()).lastInsertRowid;
        c.log('mailbox.created', f.address);
        return { mailbox: mbOut(db.prepare('SELECT * FROM mailboxes WHERE id=?').get(id), originOf(c)) };
      } catch (e) { if (/UNIQUE/.test(e.message)) fail(409, 'That address is already connected'); throw e; }
    } },
    { method: 'PUT', path: '/api/mailboxes/:id', auth: 'ws', perm: 'settings.manage', handler: async c => {
      const mb = ownMb(c), f = mbFields(c, await c.body(), mb);
      try { db.prepare(`UPDATE mailboxes SET ${Object.keys(f).map(k => k + '=?').join(', ')} WHERE id=?`).run(...Object.values(f), mb.id); } catch (e) { if (/UNIQUE/.test(e.message)) fail(409, 'That address is already connected'); throw e; }
      c.log('mailbox.updated', f.address);
      return { mailbox: mbOut(db.prepare('SELECT * FROM mailboxes WHERE id=?').get(mb.id), originOf(c)) };
    } },
    { method: 'POST', path: '/api/mailboxes/:id/rotate', auth: 'ws', perm: 'settings.manage', handler: c => {
      const mb = ownMb(c); db.prepare('UPDATE mailboxes SET inbound_token=? WHERE id=?').run(token(), mb.id); c.log('mailbox.rotated', mb.address);
      return { mailbox: mbOut(db.prepare('SELECT * FROM mailboxes WHERE id=?').get(mb.id), originOf(c)) };
    } },
    { method: 'POST', path: '/api/mailboxes/:id/test', auth: 'ws', perm: 'settings.manage', handler: async c => {
      const mb = ownMb(c), b = await c.body();
      const r = await receiveEmail({ ...mb, auto_reply: 0 }, { fromEmail: str(b.from, 200).toLowerCase() || c.me.email, fromName: str(b.name, 100) || c.me.name, subject: str(b.subject, 200) || 'Test email from Chatly',
        text: str(b.text, 5000) || 'This is a test message sent from Settings → Email channel. Replying to it here emails the sender.', messageId: `<test.${token()}@${mailDomain()}>`, references: [] });
      return { action: r.action, reason: r.reason, ticket: r.ticket ? { id: r.ticket.id, number: r.ticket.number } : null };
    } },
    { method: 'DELETE', path: '/api/mailboxes/:id', auth: 'ws', perm: 'settings.manage', handler: c => {
      const mb = ownMb(c); db.prepare('DELETE FROM mailboxes WHERE id=?').run(mb.id); c.log('mailbox.deleted', mb.address); return {};
    } },
  ],
});
