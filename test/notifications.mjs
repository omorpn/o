// Notifications: in-app center + realtime, preferences, quiet hours, email, web push (decrypted), mentions, SLA, platform alerts.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createECDH, randomBytes, hkdfSync, createDecipheriv, createPublicKey, verify } from 'node:crypto';
process.env.DB_FILE = ':memory:';
process.env.ALLOW_INSECURE_PUSH = '1';
process.env.SLA_CHECK_MS = '3600000';
const { server } = await import('../server/index.js');
const { db } = await import('../server/core/db.js');
const { runSlaCheck, mentionedMembers } = await import('../server/modules/notifications/index.js');
await new Promise(r => server.listen(0, r));
const B = `http://localhost:${server.address().port}`;
const j = async (p, method = 'GET', body, cookie) => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieOf = r => r.headers.get('set-cookie').split(';')[0];
const listen = ck => {
  const events = [], ac = new AbortController();
  fetch(B + '/api/events', { headers: { cookie: ck }, signal: ac.signal }).then(async r => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) { buf += dec.decode(c); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const m = f.match(/event: ([\w.]+)\ndata: (.*)/); if (m) events.push([m[1], JSON.parse(m[2])]); } }
  }).catch(() => {});
  return { events, stop: () => ac.abort(), notes: () => events.filter(e => e[0] === 'notification').map(e => e[1]) };
};
const list = async ck => (await j('/api/notifications', 'GET', null, ck)).body;

// ---------- fake SMTP + push service ----------
const mails = [];
const smtp = net.createServer(sock => {
  let data = false, buf = '', cur = '';
  sock.write('220 fake\r\n');
  sock.on('data', d => {
    buf += d;
    if (data) { if (buf.includes('\r\n.\r\n')) { mails.push(cur + buf); buf = ''; cur = ''; data = false; sock.write('250 queued\r\n'); } return; }
    let i; while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2); cur += line + '\n';
      if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
      else if (/^AUTH/.test(line)) sock.write('235 ok\r\n');
      else if (/^(MAIL|RCPT)/.test(line)) sock.write('250 ok\r\n');
      else if (line === 'DATA') { sock.write('354 go\r\n'); data = true; }
      else if (line === 'QUIT') sock.end('221 bye\r\n');
    }
  });
});
await new Promise(r => smtp.listen(0, r));
process.env.SMTP_URL = `smtp://u:p@127.0.0.1:${smtp.address().port}`;
const subj = m => Buffer.from((m.match(/Subject: =\?UTF-8\?B\?(.*?)\?=/) || [])[1] || '', 'base64').toString();
const rcpt = m => (m.match(/RCPT TO:<([^>]+)>/) || [])[1];

const pushes = []; let pushStatus = 201;
const pushSrv = http.createServer((req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { pushes.push({ headers: req.headers, body: Buffer.concat(chunks), path: req.url }); res.writeHead(pushStatus); res.end(); }); });
await new Promise(r => pushSrv.listen(0, r));
const browser = createECDH('prime256v1'); browser.generateKeys(); const authSecret = randomBytes(16);
/** Decrypts like a browser's push service would (RFC 8291). */
function decryptPush(body) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const uaPublic = browser.getPublicKey(), secret = browser.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain.at(-1), 2, 'padding delimiter'); return JSON.parse(plain.subarray(0, -1).toString());
}
function verifyVapid(headers, expectedAud) {
  const [, t, k] = headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  const [h, c, s] = t.split('.'); const raw = Buffer.from(k, 'base64url');
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'VAPID signature valid');
  const claims = JSON.parse(Buffer.from(c, 'base64url')); assert.equal(claims.aud, expectedAud); assert.ok(claims.exp > Date.now() / 1000);
  return k;
}

// ---------- setup ----------
const root = cookieOf(await j('/api/auth/login', 'POST', { email: 'admin@example.com', password: 'admin123' }));
const rootLive = listen(root);
const owner = cookieOf(await j('/api/auth/signup', 'POST', { name: 'Olu Owner', email: 'olu@shop.co', password: 'password1', workspace: 'Shop', elapsed: 9000 }));
await sleep(100);
assert.ok((await list(root)).items.some(n => n.type === 'platform.signup' && /Shop/.test(n.title)), 'platform admin told about sign-up');
const me = (await j('/api/me', 'GET', null, owner)).body, SITE = me.sites[0].id, key = me.sites[0].site_key, WS = me.workspace.id;
const site2 = (await j('/api/sites', 'POST', { name: 'Blog' }, owner)).body.site;
const roles = (await j('/api/roles', 'GET', null, owner)).body.roles, rid = n => roles.find(r => r.name === n).id;
await j('/api/members', 'POST', { name: 'Ann Agent', email: 'ann@shop.co', password: 'password1', role_id: rid('Agent'), site_ids: [SITE] }, owner);
await j('/api/members', 'POST', { name: 'Bo Blog', email: 'bo@shop.co', password: 'password1', role_id: rid('Agent'), site_ids: [site2.id] }, owner);
await sleep(200);
assert.ok(mails.some(m => rcpt(m) === 'ann@shop.co' && /added to Shop/.test(subj(m))), 'new teammate emailed');
const ann = cookieOf(await j('/api/auth/login', 'POST', { email: 'ann@shop.co', password: 'password1' }));
const bo = cookieOf(await j('/api/auth/login', 'POST', { email: 'bo@shop.co', password: 'password1' }));
assert.ok((await list(ann)).items.some(n => n.type === 'team.added'), 'in-app welcome');
const annId = (await j('/api/me', 'GET', null, ann)).body.user.id, ownerId = me.user.id;
const annLive = listen(ann), ownerLive = listen(owner), boLive = listen(bo);
await sleep(200);
const say = (vid, body, k = key) => j('/api/widget/message', 'POST', { key: k, vid, body });
const convOf = async vid => (await j('/api/conversations', 'GET', null, owner)).body.conversations.find(c => c.visitor.id.endsWith(':' + vid));

// ---------- bot-handled chats stay quiet; handoff notifies the right people in realtime ----------
await say('visitorN00001', 'hello'); await sleep(900);
assert.equal(annLive.notes().length, 0, 'no noise while the bot handles it');
await say('visitorN00001', 'talk to a human'); await sleep(900);
const h1 = annLive.notes().find(n => n.type === 'chat.handoff');
assert.ok(h1 && /wants to talk to a human/.test(h1.title) && h1.link.includes(`inbox/${WS}/`), 'realtime handoff notification');
assert.ok(ownerLive.notes().some(n => n.type === 'chat.handoff'));
assert.equal(boLive.notes().length, 0, 'teammates without access to that website are not notified');
assert.equal(mails.filter(m => /needs a human/.test(subj(m))).length, 0, 'online users get no email');

// ---------- notification center ----------
let a = await list(ann);
assert.ok(a.unread >= 2 && a.items[0].workspace_name === 'Shop');
assert.equal((await j('/api/notifications/read', 'POST', { ids: [a.items[0].id] }, ann)).body.unread, a.unread - 1);
assert.equal((await j('/api/notifications/read', 'POST', { all: true }, ann)).body.unread, 0);
assert.ok(annLive.events.some(e => e[0] === 'notifications.read'), 'other tabs update their badge');
await j('/api/notifications', 'DELETE', null, ann);
assert.equal((await list(ann)).items.length, 0, 'clear read');
assert.equal((await j('/api/notifications/read', 'POST', { ids: [a.items[0].id] }, bo)).body.unread, (await list(bo)).unread, "can't touch someone else's");

// ---------- assignment, messages, mentions, ratings ----------
const c1 = await convOf('visitorN00001');
await j(`/api/conversations/${c1.id}/assign`, 'POST', { agent_id: annId }, owner); await sleep(100);
assert.ok(annLive.notes().some(n => n.type === 'chat.assigned' && /Olu Owner assigned you/.test(n.title)));
await j(`/api/conversations/${c1.id}/assign`, 'POST', { agent_id: ownerId }, owner); await sleep(100);
assert.ok(!ownerLive.notes().some(n => n.type === 'chat.assigned'), 'no notification for assigning yourself');
await j(`/api/conversations/${c1.id}/assign`, 'POST', { agent_id: annId }, owner);
await say('visitorN00001', 'are you there?'); await sleep(200);
await say('visitorN00001', 'hello??'); await sleep(200);
const msgNotes = annLive.notes().filter(n => n.type === 'chat.message');
assert.equal(msgNotes.length, 1, 'assignee notified once (follow-ups throttled)');
assert.equal(ownerLive.notes().filter(n => n.type === 'chat.message').length, 0, 'only the assignee for assigned chats');
await j(`/api/conversations/${c1.id}/note`, 'POST', { body: 'Hey @ann can you check the order? cc @nobody @bo' }, owner); await sleep(100);
assert.ok(annLive.notes().some(n => n.type === 'chat.mention' && /Olu Owner mentioned you/.test(n.title)));
assert.equal(boLive.notes().filter(n => n.type === 'chat.mention').length, 0, "mention of someone who can't see the chat is ignored");
assert.deepEqual(mentionedMembers(WS, 'thanks @Ann!', 0).map(u => u.email), ['ann@shop.co']);
assert.deepEqual(mentionedMembers(WS, 'email@ann.com', 0), [], 'emails are not mentions');
assert.deepEqual(mentionedMembers(WS, 'ping @OluOwner', 0).map(u => u.email), ['olu@shop.co']);
await j(`/api/conversations/${c1.id}/status`, 'POST', { status: 'closed' }, ann);
await j('/api/widget/rate', 'POST', { key, vid: 'visitorN00001', rating: 2, comment: 'slow' }); await sleep(100);
assert.ok(annLive.notes().some(n => n.type === 'chat.rated' && n.title.startsWith('★★☆☆☆') && n.body === 'slow'));

// ---------- preferences ----------
const prefs = (await j('/api/notifications/prefs', 'GET', null, ann)).body;
assert.ok(prefs.types.find(t => t.key === 'chat.message').channels.push);
assert.ok(!prefs.types.some(t => t.key === 'platform.fraud'), 'platform types hidden from customers');
assert.ok((await j('/api/notifications/prefs', 'GET', null, root)).body.types.some(t => t.key === 'platform.fraud'));
assert.ok(prefs.push.publicKey.length > 80);
assert.equal((await j('/api/notifications/prefs', 'PUT', { settings: { timezone: 'Mars/Base' } }, ann)).status, 400);
assert.equal((await j('/api/notifications/prefs', 'PUT', { types: { 'chat.mention': { in_app: false } } }, ann)).status, 200);
await j(`/api/conversations/${c1.id}/note`, 'POST', { body: '@ann again' }, owner); await sleep(100);
assert.equal(annLive.notes().filter(n => n.type === 'chat.mention').length, 1, 'turned off in-app mentions');

// ---------- email when away, quiet hours ----------
annLive.stop(); await sleep(150);
await say('visitorN00002', 'talk to a human'); await sleep(1000);
assert.ok(mails.some(m => rcpt(m) === 'ann@shop.co' && /New message from .* — needs a human/.test(subj(m))), 'offline teammate emailed');
assert.ok(!mails.some(m => rcpt(m) === 'olu@shop.co' && /needs a human/.test(subj(m))), 'online owner not emailed');
const before = mails.length;
await j('/api/notifications/prefs', 'PUT', { settings: { quietEnabled: true, quietStart: '00:00', quietEnd: '23:59', timezone: 'UTC' } }, ann);
await say('visitorN00003', 'talk to a human'); await sleep(1000);
assert.equal(mails.filter(m => rcpt(m) === 'ann@shop.co').length, mails.slice(0, before).filter(m => rcpt(m) === 'ann@shop.co').length, 'quiet hours: no email');
assert.ok((await list(ann)).items.some(n => n.type === 'chat.handoff' && /visitorN00003|Visitor|visitor/i.test(n.title)), 'quiet hours: still in the notification center');
await j('/api/notifications/prefs', 'PUT', { settings: { quietEnabled: false } }, ann);
await j(`/api/settings?site=${SITE}`, 'PUT', { emailNotifications: false }, owner);
const b2 = mails.length;
await say('visitorN00004', 'talk to a human'); await sleep(1000);
assert.equal(mails.length, b2, 'website switch turns team emails off');
await j(`/api/settings?site=${SITE}`, 'PUT', { emailNotifications: true }, owner);

// ---------- web push ----------
const sub = { endpoint: `http://localhost:${pushSrv.address().port}/push/abc123`, keys: { p256dh: browser.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };
assert.equal((await j('/api/notifications/push', 'POST', { ...sub, keys: { p256dh: 'short', auth: 'x' } }, ann)).status, 400);
delete process.env.ALLOW_INSECURE_PUSH;
assert.equal((await j('/api/notifications/push', 'POST', sub, ann)).status, 400, 'only real push services allowed in production');
assert.equal((await j('/api/notifications/push', 'POST', { ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/x' }, ann)).status, 200);
await j('/api/notifications/push', 'DELETE', { endpoint: 'https://fcm.googleapis.com/fcm/send/x' }, ann);
process.env.ALLOW_INSECURE_PUSH = '1';
assert.equal((await j('/api/notifications/push', 'POST', sub, ann)).status, 200);
const t = await j('/api/notifications/test', 'POST', null, ann);
assert.equal(t.body.delivered.push, 1);
await sleep(400);
assert.equal(pushes.length, 1);
const p0 = pushes[0];
assert.equal(p0.headers['content-encoding'], 'aes128gcm'); assert.equal(p0.path, '/push/abc123');
const k = verifyVapid(p0.headers, `http://localhost:${pushSrv.address().port}`);
assert.equal(k, prefs.push.publicKey, 'signed with the advertised VAPID key');
const payload = decryptPush(p0.body);
assert.equal(payload.title, '🔔 Test notification'); assert.match(payload.url, /\/app\//);
// real event → push to the offline assignee
await say('visitorN00005', 'talk to a human'); await sleep(1000);
const handoffPush = pushes.slice(1).map(p => decryptPush(p.body)).find(p => /wants to talk to a human/.test(p.title));
assert.ok(handoffPush && pushes.at(-1).headers.urgency === 'high', 'handoff pushed with high urgency');
// expired subscription is cleaned up
pushStatus = 410;
await j('/api/notifications/test', 'POST', null, ann); await sleep(400);
assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n, 0, 'gone subscription removed');

// ---------- response-time alerts ----------
await j(`/api/settings?site=${SITE}`, 'PUT', { slaMinutes: 3 }, owner);
const c4 = await convOf('visitorN00004');
db.prepare("UPDATE messages SET created=created-600000 WHERE conv_id=? AND sender='visitor'").run(c4.id);
assert.equal(runSlaCheck(), 1, 'one late chat');
const late = (await list(owner)).items.find(n => n.type === 'chat.unanswered');
assert.ok(late && /waiting 1\d min/.test(late.title));
assert.equal(runSlaCheck(), 0, 'not repeated for the same message');
await j(`/api/conversations/${c4.id}/messages`, 'POST', { body: 'Sorry for the wait!' }, owner);
db.prepare("UPDATE messages SET created=created-600000 WHERE conv_id=?").run(c4.id);
assert.equal(runSlaCheck(), 0, 'answered chats are fine');

// ---------- platform alerts & announcements ----------
await j('/api/widget/message', 'POST', { key, vid: 'visitorSPAM01', body: 'EARN $5000 crypto investment click here https://bit.ly/x https://a.xyz' }); await sleep(200);
assert.ok(rootLive.notes().some(n => n.type === 'platform.fraud' && /Fraud blocked: visitor message/.test(n.title)), 'platform admins alerted');
await j('/api/widget/message', 'POST', { key, vid: 'visitorSPAM02', body: 'EARN $5000 crypto investment click here https://bit.ly/y https://b.xyz' }); await sleep(200);
assert.equal(rootLive.notes().filter(n => n.type === 'platform.fraud').length, 1, 'fraud alerts are batched (10 min)');
assert.equal(ownerLive.notes().filter(n => n.type === 'platform.fraud').length, 0, 'customers never see platform alerts');
await j('/api/platform/settings', 'PUT', { announcement: 'Maintenance tonight 02:00 UTC' }, root); await sleep(200);
assert.ok(ownerLive.notes().some(n => n.type === 'system.announcement' && n.body === 'Maintenance tonight 02:00 UTC'));
await j('/api/platform/workspaces/' + WS, 'PUT', { suspended: true, reason: 'Unpaid invoice' }, root); await sleep(200);
assert.ok((await list(owner)).items.some(n => n.type === 'workspace.status' && n.body === 'Unpaid invoice'), 'owner told about suspension');
assert.ok(mails.some(m => rcpt(m) === 'olu@shop.co' && /suspended/.test(subj(m))), 'and emailed even though they were online');
await j('/api/platform/workspaces/' + WS, 'PUT', { suspended: false }, root);
assert.equal((await j('/api/notifications', 'GET', null, owner)).status, 200, 'notification center works even while suspended');

rootLive.stop(); ownerLive.stop(); boLive.stop(); smtp.close(); pushSrv.close();
console.log('all notification tests passed');
server.closeAllConnections?.(); server.close(); process.exit(0);
