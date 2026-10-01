import net from 'node:net';
import tls from 'node:tls';

/** Minimal dependency-free SMTP client. Configure with SMTP_URL (smtp://user:pass@host:587 → STARTTLS, smtps://…:465 → TLS) and SMTP_FROM. */
export const mailConfigured = () => !!process.env.SMTP_URL;
const clean = s => String(s).replace(/[\r\n]+/g, ' ').trim();
const b64 = s => Buffer.from(s).toString('base64');

function lineReader(sock) {
  let buf = ''; const replies = [], waiters = [];
  const push = r => (waiters.length ? waiters.shift().res(r) : replies.push(r));
  sock.on('data', d => { buf += d; let m; while ((m = buf.match(/^(?:\d{3}-[^\n]*\n)*\d{3}[ ][^\n]*\n/))) { buf = buf.slice(m[0].length); push(m[0]); } });
  const fail = e => { for (const w of waiters.splice(0)) w.rej(e); };
  sock.on('error', fail); sock.on('close', () => fail(new Error('SMTP connection closed')));
  return () => new Promise((res, rej) => (replies.length ? res(replies.shift()) : waiters.push({ res, rej })));
}

/**
 * @param {{to: string, subject: string, text: string, fromName?: string, replyTo?: string, messageId?: string, inReplyTo?: string, references?: string, autoReply?: boolean}} m
 *        autoReply marks the message Auto-Submitted so mail servers and helpdesks don't answer it (prevents loops)
 * @returns {Promise<string>} the Message-ID used
 */
export async function sendMail({ to, subject, text, fromName, replyTo, messageId, inReplyTo, references, autoReply = false }) {
  if (!mailConfigured()) throw new Error('SMTP is not configured');
  to = clean(to); if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(to)) throw new Error('Bad recipient');
  const u = new URL(process.env.SMTP_URL), secure = u.protocol === 'smtps:';
  const port = Number(u.port) || (secure ? 465 : 587), host = u.hostname;
  const from = clean(process.env.SMTP_FROM || decodeURIComponent(u.username) || 'chatly@localhost');
  const fromAddr = (from.match(/<([^>]+)>/) || [, from])[1];
  const fromHeader = fromName ? `=?UTF-8?B?${b64(clean(fromName))}?= <${fromAddr}>` : from;
  const msgId = messageId || `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${fromAddr.split('@')[1] || 'chatly.local'}>`;
  const angle = v => clean(v).split(/\s+/).filter(x => /^<[^<>\s]+>$/.test(x)).join(' ');
  const work = (async () => {
    let sock = await new Promise((res, rej) => {
      const s = secure ? tls.connect({ host, port, servername: host }, () => res(s)) : net.connect({ host, port }, () => res(s));
      s.once('error', rej);
    });
    let read = lineReader(sock);
    const expect = async (code) => { const r = await read(); if (!r.startsWith(code)) throw new Error('SMTP: ' + r.trim()); return r; };
    const cmd = async (line, code) => { sock.write(line + '\r\n'); return expect(code); };
    try {
      await expect('220');
      let ehlo = await cmd('EHLO chatly.local', '250');
      if (!secure && /STARTTLS/i.test(ehlo)) {
        await cmd('STARTTLS', '220');
        sock.removeAllListeners('data');
        sock = tls.connect({ socket: sock, servername: host }); read = lineReader(sock);
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
        ehlo = await cmd('EHLO chatly.local', '250');
      }
      if (u.username) {
        const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
        await cmd('AUTH PLAIN ' + b64(`\0${user}\0${pass}`), '235');
      }
      await cmd(`MAIL FROM:<${fromAddr}>`, '250');
      await cmd(`RCPT TO:<${to}>`, '25');
      await cmd('DATA', '354');
      const body = (b64(String(text ?? '').replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g) || ['']).join('\r\n');
      const extra = [replyTo && /^[^@\s<>]+@[^@\s<>]+$/.test(clean(replyTo)) ? `Reply-To: ${clean(replyTo)}` : null, inReplyTo && angle(inReplyTo) ? `In-Reply-To: ${angle(inReplyTo)}` : null,
        references && angle(references) ? `References: ${angle(references)}` : null, autoReply ? 'Auto-Submitted: auto-replied' : null].filter(Boolean);
      const msg = [`From: ${fromHeader}`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(clean(subject))}?=`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${msgId}`, ...extra,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body, '.'].join('\r\n');
      await cmd(msg, '250');
      sock.write('QUIT\r\n');
    } finally { sock.destroy(); }
  })();
  let timer; const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('SMTP timeout')), 15000); });
  try { await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
  return msgId;
}
