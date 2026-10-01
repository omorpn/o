// Email channel: mailboxes, inbound formats (JSON, Postmark, raw MIME, Mailgun, SendGrid), threading, reopen, follow-ups,
// auto-replies, outbound replies with Message-ID threading, loop/duplicate/blocked protection, quoted-text stripping.
import assert from 'node:assert/strict';
import net from 'node:net';
process.env.DB_FILE = ':memory:';
process.env.SLA_CHECK_MS = '3600000';
process.env.SMTP_FROM = 'Chatly <notify@chatly.test>';
const { server } = await import('../server/index.js');
const { db } = await import('../server/core/db.js');
const { parseMime, stripQuoted, decodeWords, parseInbound } = await import('../server/modules/email/parse.js');
await new Promise(r => server.listen(0, r));
const B = `http://localhost:${server.address().port}`;
const j = async (p, method = 'GET', body, cookie) => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const post = async (url, body, type) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieOf = r => r.headers.get('set-cookie').split(';')[0];

// fake SMTP keeping raw messages
const sent = [];
const smtp = net.createServer(sock => {
  let data = false, buf = '', rcpt = '';
  sock.write('220 fake\r\n');
  sock.on('data', d => {
    buf += d;
    if (data) { const i = buf.indexOf('\r\n.\r\n'); if (i >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 5); data = false; sent.push({ to: rcpt, raw, ...parseMime(raw) }); sock.write('250 ok\r\n'); } else return; }
    let i; while (!data && (i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n'); else if (/^AUTH/.test(line)) sock.write('235 ok\r\n');
      else if (/^RCPT TO:<([^>]+)>/.test(line)) { rcpt = line.match(/<([^>]+)>/)[1]; sock.write('250 ok\r\n'); } else if (/^MAIL/.test(line)) sock.write('250 ok\r\n');
      else if (line === 'DATA') { sock.write('354 go\r\n'); data = true; } else if (line === 'QUIT') sock.end('221 bye\r\n');
    }
  });
});
await new Promise(r => smtp.listen(0, r));
process.env.SMTP_URL = `smtp://u:p@127.0.0.1:${smtp.address().port}`;

// ---------- parser units ----------
assert.equal(decodeWords('=?UTF-8?B?w4lsw6lu?= =?ISO-8859-1?Q?_caf=E9?='), 'Élén café');
assert.equal(stripQuoted('Thanks, that works!\n\nOn Tue, 1 Oct 2026 at 10:00, Shop <support@shop.ng> wrote:\n> old stuff\n> more'), 'Thanks, that works!');
assert.equal(stripQuoted('Yes please\n\n-----Original Message-----\nFrom: x'), 'Yes please');
assert.equal(stripQuoted('Line one\n> quoted tail\n>'), 'Line one');
const mime = ['From: "Ada Obi" <Ada@Example.ng>', 'To: support@shop.ng', 'Subject: =?UTF-8?Q?Wrong_size_=E2=80=94_order_77?=', 'Message-ID: <abc123@mail.example.ng>',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="XYZ"', '', '--XYZ', 'Content-Type: multipart/alternative; boundary="ALT"', '', '--ALT', 'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable', '', 'Hello, I got size M but ordered L. Caf=C3=A9 =', 'au lait.', '--ALT', 'Content-Type: text/html', '', '<p>Hello</p>', '--ALT--',
  '--XYZ', 'Content-Type: image/png; name="photo.png"', 'Content-Disposition: attachment; filename="photo.png"', 'Content-Transfer-Encoding: base64', '', Buffer.from('PNGDATA').toString('base64'), '--XYZ--', ''].join('\r\n');
const pm = parseMime(mime);
assert.equal(pm.fromEmail, 'ada@example.ng'); assert.equal(pm.fromName, 'Ada Obi'); assert.equal(pm.subject, 'Wrong size — order 77');
assert.equal(pm.text.trim(), 'Hello, I got size M but ordered L. Café au lait.'); assert.equal(pm.messageId, '<abc123@mail.example.ng>');
assert.equal(pm.attachments.length, 1); assert.equal(Buffer.from(pm.attachments[0].data, 'base64').toString(), 'PNGDATA');
assert.equal(parseInbound(Buffer.from('not json'), 'application/json'), null);

// ---------- setup ----------
const owner = cookieOf(await j('/api/auth/login', 'POST', { email: 'admin@example.com', password: 'admin123' }));
const dep = (await j('/api/departments', 'POST', { name: 'Support' }, owner)).body.department;
assert.equal((await j('/api/mailboxes', 'POST', { name: 'Support', address: 'not-an-email' }, owner)).status, 400);
const mb = (await j('/api/mailboxes', 'POST', { name: 'Support', address: 'Support@Shop.ng', from_name: 'Shop Support', signature: 'Kind regards,\nShop.ng team', department_id: dep.id, priority: 'high' }, owner)).body.mailbox;
assert.equal(mb.address, 'support@shop.ng'); assert.match(mb.inbound_url, /\/api\/inbound\/email\/[a-f0-9]{36}$/);
assert.equal((await j('/api/mailboxes', 'POST', { name: 'Dup', address: 'support@shop.ng' }, owner)).status, 409);
const IN = mb.inbound_url.replace(/^https?:\/\/[^/]+/, B);
assert.equal((await post(B + '/api/inbound/email/deadbeef', '{}', 'application/json')).status, 404, 'unknown token');
const ticketByNumber = n => db.prepare('SELECT * FROM tickets WHERE number=?').get(n);
const thread = id => db.prepare('SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY id').all(id);

// ---------- generic JSON → new ticket + auto-reply ----------
let r = await post(IN, JSON.stringify({ from: 'Kemi <kemi@buyer.ng>', subject: 'Where is my order?', text: 'Order 1001 has not arrived.', message_id: '<m1@buyer.ng>' }), 'application/json');
assert.equal(r.status, 200); assert.equal(r.body.action, 'created');
const t1 = ticketByNumber(r.body.ticket.number);
assert.equal(t1.channel, 'email'); assert.equal(t1.requester_email, 'kemi@buyer.ng'); assert.equal(t1.requester_name, 'Kemi'); assert.equal(t1.priority, 'high'); assert.equal(t1.department_id, dep.id); assert.equal(t1.mailbox_id, mb.id);
await sleep(300);
const ack = sent.find(m => m.to === 'kemi@buyer.ng');
assert.ok(ack, 'auto-reply sent'); assert.match(ack.subject, /\[#1\]/); assert.match(ack.raw, /Auto-Submitted: auto-replied/); assert.match(ack.raw, /Reply-To: support@shop\.ng/); assert.equal(ack.inReplyTo, '<m1@buyer.ng>');
assert.match(ack.text, /request #1/);

// ---------- agent reply goes out threaded ----------
const rep = (await j(`/api/tickets/${t1.id}/reply`, 'POST', { body: 'Hi Kemi, it ships tomorrow.' }, owner)).body;
await sleep(300);
const out = sent.at(-1);
assert.equal(out.to, 'kemi@buyer.ng'); assert.equal(out.subject, 'Re: Where is my order? [#1]'); assert.match(out.text, /ships tomorrow[\s\S]*Kind regards,\r?\nShop\.ng team[\s\S]*Request #1/);
assert.match(out.raw, /Reply-To: support@shop\.ng/); assert.ok(out.references.includes('<m1@buyer.ng>'));
assert.equal(db.prepare('SELECT email_message_id FROM ticket_messages WHERE id=?').get(rep.message.id).email_message_id, out.messageId, 'outgoing Message-ID stored for threading');
assert.equal(rep.ticket.status, 'pending');

// ---------- customer reply (raw MIME, In-Reply-To) reopens ----------
const reply = [`From: Kemi <kemi@buyer.ng>`, 'To: support@shop.ng', 'Subject: Re: Where is my order? [#1]', 'Message-ID: <m2@buyer.ng>', `In-Reply-To: ${out.messageId}`, `References: <m1@buyer.ng> ${out.messageId}`,
  'Content-Type: text/plain; charset=utf-8', '', 'Great, thank you!', '', 'On Wed, Shop Support wrote:', '> Hi Kemi, it ships tomorrow.'].join('\r\n');
r = await post(IN, reply, 'message/rfc822');
assert.equal(r.body.action, 'replied'); assert.equal(r.body.ticket.number, 1);
let tm = thread(t1.id).filter(m => m.author_type === 'customer');
assert.equal(tm.at(-1).body, 'Great, thank you!', 'quoted text stripped'); assert.equal(ticketByNumber(1).status, 'open', 'reply reopens pending ticket');
r = await post(IN, reply, 'message/rfc822');
assert.equal(r.body.action, 'ignored'); assert.equal(r.body.reason, 'duplicate');

// ---------- subject token threading (no headers), only for the same requester ----------
r = await post(IN, JSON.stringify({ from: 'kemi@buyer.ng', subject: 'RE: Where is my order? [#1]', text: 'Any update?' }), 'application/json');
assert.equal(r.body.action, 'replied');
r = await post(IN, JSON.stringify({ from: 'mallory@evil.ng', subject: 'Re: [#1]', text: 'hijack' }), 'application/json');
assert.equal(r.body.action, 'created', "someone else's [#1] does not join the ticket");

// ---------- closed ticket → follow-up ----------
await j(`/api/tickets/${t1.id}`, 'PUT', { status: 'closed' }, owner);
r = await post(IN, JSON.stringify({ from: 'kemi@buyer.ng', subject: 'Re: Where is my order? [#1]', text: 'It broke after a week', in_reply_to: out.messageId }), 'application/json');
assert.equal(r.body.action, 'followup');
const fu = ticketByNumber(r.body.ticket.number);
assert.equal(fu.subject, 'Where is my order?'); assert.ok(thread(fu.id).some(m => /Follow-up to closed ticket #1/.test(m.body)));

// ---------- Postmark ----------
r = await post(IN, JSON.stringify({ FromFull: { Email: 'Tolu@Mail.ng', Name: 'Tolu' }, To: 'support@shop.ng', Subject: 'Invoice please', TextBody: 'Full text\n\nOn x wrote:\n> y', StrippedTextReply: 'Please send an invoice',
  MessageID: 'pm-1', Headers: [{ Name: 'Message-ID', Value: '<pm-1@mail.ng>' }], Attachments: [{ Name: 'receipt.pdf', ContentType: 'application/pdf', Content: Buffer.from('%PDF-1.4').toString('base64') }] }), 'application/json');
assert.equal(r.body.action, 'created');
let pt = ticketByNumber(r.body.ticket.number), pmsg = thread(pt.id)[0];
assert.equal(pt.requester_email, 'tolu@mail.ng'); assert.equal(pmsg.body, 'Please send an invoice'); assert.equal(JSON.parse(pmsg.attachments)[0].name, 'receipt.pdf');

// ---------- Mailgun (urlencoded) ----------
r = await post(IN, new URLSearchParams({ sender: 'bayo@mail.ng', from: 'Bayo <bayo@mail.ng>', subject: 'Discount code', 'body-plain': 'Code SAVE10 fails', 'stripped-text': 'Code SAVE10 fails', 'Message-Id': '<mg-1@mail.ng>' }).toString(), 'application/x-www-form-urlencoded');
assert.equal(r.body.action, 'created'); assert.equal(ticketByNumber(r.body.ticket.number).requester_name, 'Bayo');

// ---------- SendGrid (multipart) ----------
const bd = 'sgB0undary';
const mp = [`--${bd}`, 'Content-Disposition: form-data; name="from"', '', 'Chi <chi@mail.ng>', `--${bd}`, 'Content-Disposition: form-data; name="subject"', '', 'Résumé of issue', `--${bd}`,
  'Content-Disposition: form-data; name="text"', '', 'The app crashes ✨', `--${bd}`, 'Content-Disposition: form-data; name="headers"', '', 'Message-ID: <sg-1@mail.ng>\nFrom: Chi <chi@mail.ng>', `--${bd}--`, ''].join('\r\n');
r = await post(IN, Buffer.from(mp), `multipart/form-data; boundary=${bd}`);
assert.equal(r.body.action, 'created');
const sg = ticketByNumber(r.body.ticket.number); assert.equal(sg.subject, 'Résumé of issue'); assert.equal(thread(sg.id)[0].body, 'The app crashes ✨');

// ---------- protection ----------
const before = db.prepare('SELECT COUNT(*) n FROM tickets').get().n;
r = await post(IN, JSON.stringify({ from: 'support@shop.ng', subject: 'loop', text: 'x' }), 'application/json'); assert.equal(r.body.action, 'ignored');
r = await post(IN, JSON.stringify({ from: 'notify@chatly.test', subject: 'loop', text: 'x' }), 'application/json'); assert.equal(r.body.action, 'ignored');
r = await post(IN, JSON.stringify({ from: 'kemi@buyer.ng', subject: `Re: [#${fu.number}]`, text: 'Out of office', auto_submitted: true, in_reply_to: '<m1@buyer.ng>' }), 'application/json');
assert.equal(r.body.action, 'ignored', 'auto-replies do not reopen tickets');
await j('/api/spam/blocks', 'POST', { type: 'domain', value: 'spammy.biz' }, owner).catch(() => {});
db.prepare("INSERT INTO blocklist(workspace_id,type,value,reason,created_by,created) VALUES(?,?,?,?,?,?)").run(1, 'email', 'blocked@x.ng', 'test', 'test', Date.now());
r = await post(IN, JSON.stringify({ from: 'blocked@x.ng', subject: 'hi', text: 'x' }), 'application/json'); assert.equal(r.body.action, 'ignored'); assert.equal(r.body.reason, 'sender blocked');
assert.equal(db.prepare('SELECT COUNT(*) n FROM tickets').get().n, before);
const autoNew = await post(IN, JSON.stringify({ from: 'robot@x.ng', subject: 'Delivery Status', text: 'auto', auto_submitted: true }), 'application/json');
await sleep(200); assert.ok(!sent.some(m => m.to === 'robot@x.ng'), 'no auto-reply to automated mail'); assert.equal(autoNew.body.action, 'created');

// ---------- mailbox admin ----------
await j(`/api/mailboxes/${mb.id}`, 'PUT', { enabled: false }, owner);
r = await post(IN, JSON.stringify({ from: 'a@b.ng', subject: 'x', text: 'y' }), 'application/json'); assert.equal(r.body.reason, 'mailbox disabled');
await j(`/api/mailboxes/${mb.id}`, 'PUT', { enabled: true }, owner);
const rot = (await j(`/api/mailboxes/${mb.id}/rotate`, 'POST', null, owner)).body.mailbox;
assert.notEqual(rot.inbound_url, mb.inbound_url); assert.equal((await post(IN, '{}', 'application/json')).status, 404, 'old token stops working');
const test = (await j(`/api/mailboxes/${mb.id}/test`, 'POST', { subject: 'Hello test' }, owner)).body;
assert.equal(test.action, 'created'); assert.equal(ticketByNumber(test.ticket.number).requester_email, 'admin@example.com');
const list = (await j('/api/mailboxes', 'GET', null, owner)).body;
assert.equal(list.smtp, true); assert.ok(list.mailboxes[0].received >= 8);
await j('/api/modules/email', 'PUT', { enabled: false }, owner);
r = await post(rot.inbound_url.replace(/^https?:\/\/[^/]+/, B), JSON.stringify({ from: 'a@b.ng', subject: 'x', text: 'y' }), 'application/json'); assert.equal(r.body.reason, 'mailbox disabled');
assert.equal((await j('/api/mailboxes', 'GET', null, owner)).status, 403);
await j('/api/modules/email', 'PUT', { enabled: true }, owner);

// ---------- outbound failure is visible on the ticket ----------
const savedUrl = process.env.SMTP_URL; process.env.SMTP_URL = 'smtp://u:p@127.0.0.1:1';
await j(`/api/tickets/${pt.id}/reply`, 'POST', { body: 'Invoice attached' }, owner); await sleep(500);
assert.ok(thread(pt.id).some(m => m.kind === 'note' && /could not be sent/.test(m.body)), 'send failure noted on the ticket');
process.env.SMTP_URL = savedUrl;

smtp.close();
console.log('all email tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
