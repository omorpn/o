/** Live chat (core): inbox, conversations, visitors, saved replies, per-website widget settings, realtime stream. */
import { db, now, getSettings, setSettings } from '../../core/db.js';
import { fail, str, toInt } from '../../core/http.js';
import { emit, on } from '../../core/events.js';
import { defineModule } from '../../core/modules.js';
import { memberOf, memberPerms } from '../../core/auth.js';
import { sendMail, mailConfigured } from '../../core/mail.js';
import { sse, frame, put, toAgents, toVisitor, toSiteVisitors, agentStreams, visitorStreams, isOnline, setAway, agentStatus } from '../../core/realtime.js';
import { isEnabled } from '../../core/modules.js';
import * as fraud from '../fraud/engine.js';
import { widgetRoutes } from './widget.js';
import { visitorOut, getConv, convOut, msgOut, emitConv, addMessage, saveUpload, transcriptText, teamAvailable, siteRow, routing, validDepartment } from './service.js';

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const PRIORITY_RANK = "CASE c.priority WHEN 'urgent' THEN 3 WHEN 'high' THEN 2 WHEN 'low' THEN 0 ELSE 1 END";

const logMailErr = e => console.error('mail error:', e.message);
function emailVisitor(convId, subject, text) {
  if (!mailConfigured()) return;
  const v = db.prepare('SELECT v.email FROM visitors v JOIN conversations c ON c.visitor_id=v.id WHERE c.id=?').get(convId);
  if (v?.email) sendMail({ to: v.email, subject, text }).catch(logMailErr);
}

/** Loads a conversation the current user may see (workspace, website access, assignment rules). */
export function loadConv(c, id) {
  const conv = getConv(id);
  if (!conv || conv.workspace_id !== c.ws || !c.auth.siteIds.includes(conv.site_id)) fail(404, 'Conversation not found');
  if (!c.can('chats.view_all') && conv.assignee_id && conv.assignee_id !== c.me.id) fail(404, 'Conversation not found');
  return conv;
}

const BOOL_SETTINGS = ['gradient', 'prechatForm', 'showBranding', 'emailNotifications', 'emailReplies', 'emailTranscript', 'askEmail', 'botEnabled', 'proactiveEnabled', 'aiEnabled', 'ratingEnabled', 'businessHoursEnabled'];
const TEXT_SETTINGS = ['brandName', 'title', 'subtitle', 'greeting', 'offlineMessage', 'handoffMessage', 'fallbackMessage', 'proactiveMessage', 'allowedOrigins', 'aiInstructions', 'launcherLabel', 'avatarUrl', 'webhookUrl', 'timezone', 'hoursStart', 'hoursEnd', 'hoursDays'];

async function conversationAction(c) {
  const conv = loadConv(c, c.int('id')), action = c.params.action;
  return applyAction(c, conv, action, await c.body(action === 'upload' ? 4_500_000 : 200_000));
}

/** One inbox action on one conversation; shared by the per-conversation routes and bulk actions. */
async function applyAction(c, conv, action, b) {
  const refresh = () => emitConv(getConv(conv.id));
  const S = getSettings(conv.site_id), me = c.me;
  const takeOver = () => db.prepare("UPDATE conversations SET bot_active=0, needs_human=0, unread=0, status='open', first_reply=COALESCE(first_reply,?), assignee_id=COALESCE(assignee_id,?) WHERE id=?").run(now() - conv.created, me.id, conv.id);
  switch (action) {
    case 'messages': {
      c.need('chats.reply'); const body = str(b.body, 4000); if (!body) fail(400, 'Empty message');
      const out = fraud.record({ kind: 'agent_message', workspaceId: c.ws, siteId: conv.site_id, userId: me.id, summary: body, signals: fraud.scoreAgentMessage({ text: body }) });
      fraud.maybeAutoSuspend(c.ws);
      if (out.blocked) fail(422, 'This message was blocked by platform safety checks (it looks like a request for passwords or payment details with a link). Contact support if this is a mistake.');
      takeOver();
      return { message: addMessage(getConv(conv.id), 'agent', body, { senderId: me.id, senderName: me.name }) };
    }
    case 'note': {
      c.need('chats.reply'); const body = str(b.body, 4000); if (!body) fail(400, 'Empty note');
      const m = addMessage(conv, 'note', body, { senderId: me.id, senderName: me.name });
      emit('note.created', { conv: getConv(conv.id), message: m, by: me });
      return { message: m };
    }
    case 'upload': {
      c.need('chats.reply'); const att = await saveUpload(b); takeOver();
      return { message: addMessage(getConv(conv.id), 'agent', `📎 ${att.name}`, { senderId: me.id, senderName: me.name, attachment: att }) };
    }
    case 'tags': {
      c.need('chats.reply');
      const tags = [...new Set((Array.isArray(b.tags) ? b.tags : []).map(t => str(t, 24).toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '')).filter(Boolean))].slice(0, 8);
      db.prepare('UPDATE conversations SET tags=? WHERE id=?').run(tags.length ? JSON.stringify(tags) : null, conv.id); refresh(); return { tags };
    }
    case 'read': db.prepare('UPDATE conversations SET unread=0 WHERE id=?').run(conv.id); refresh(); return {};
    case 'typing': c.need('chats.reply'); toVisitor(conv.visitor_id, 'typing', { who: 'agent', name: me.name }); return {};
    case 'status': {
      c.need('chats.close'); const s = b.status === 'closed' ? 'closed' : 'open';
      db.prepare('UPDATE conversations SET status=?, needs_human=0 WHERE id=?').run(s, conv.id);
      if (s === 'closed') {
        addMessage(getConv(conv.id), 'system', `${me.name} closed this conversation`); toVisitor(conv.visitor_id, 'closed', { rating: !!S.ratingEnabled });
        emit('conversation.closed', { conv: getConv(conv.id), by: me });
      }
      refresh(); return {};
    }
    case 'assign': {
      c.need('chats.assign');
      const aid = b.agent_id == null ? null : toInt(b.agent_id);
      if (aid) {
        const mem = memberOf(aid, c.ws);
        if (!mem || (mem.site_ids && !JSON.parse(mem.site_ids).includes(conv.site_id))) fail(400, "That teammate doesn't have access to this website");
        if (!memberPerms(mem).has('chats.reply')) fail(400, "That teammate's role can't reply to chats");
      }
      const prev = conv.assignee_id;
      db.prepare('UPDATE conversations SET assignee_id=? WHERE id=?').run(aid, conv.id);
      refresh();
      // agents who lost visibility of this chat (no view_all) get a removal event
      if (prev && prev !== aid) for (const s of agentStreams) if (s.ws === c.ws && s.userId === prev && !s.viewAll) put(s.res, frame('deleted', { id: conv.id }));
      if (aid && aid !== prev) emit('conversation.assigned', { conv: getConv(conv.id), assigneeId: aid, by: me });
      return {};
    }
    case 'priority': {
      c.need('chats.reply'); if (!PRIORITIES.includes(b.priority)) fail(400, 'Priority must be low, normal, high or urgent');
      db.prepare('UPDATE conversations SET priority=? WHERE id=?').run(b.priority, conv.id); refresh(); return { priority: b.priority };
    }
    case 'snooze': {
      c.need('chats.reply');
      const until = b.until == null ? null : Number(b.until);
      if (until !== null && !(until > now() && until < now() + 90 * 86400_000)) fail(400, 'Snooze until a time within the next 90 days');
      db.prepare('UPDATE conversations SET snoozed_until=? WHERE id=?').run(until, conv.id);
      if (until) addMessage(getConv(conv.id), 'note', `${me.name} snoozed this conversation until ${new Date(until).toUTCString()}`, { senderId: me.id, senderName: me.name });
      refresh(); return { snoozed_until: until };
    }
    case 'department': {
      c.need('chats.assign');
      if (!isEnabled(c.ws, 'departments')) fail(403, 'The Departments module is not enabled for this workspace.', { module: 'departments' });
      const dep = b.department_id == null ? null : validDepartment(c.ws, b.department_id);
      if (b.department_id != null && !dep) fail(400, 'Unknown department');
      const prev = conv.assignee_id;
      db.prepare('UPDATE conversations SET department_id=?, assignee_id=NULL WHERE id=?').run(dep, conv.id);
      const name = dep ? db.prepare('SELECT name FROM departments WHERE id=?').get(dep).name : null;
      addMessage(getConv(conv.id), 'note', name ? `${me.name} transferred this conversation to ${name}` : `${me.name} removed the department`, { senderId: me.id, senderName: me.name });
      if (prev) for (const s of agentStreams) if (s.ws === c.ws && s.userId === prev && !s.viewAll) put(s.res, frame('deleted', { id: conv.id }));
      try { routing.assign?.(getConv(conv.id)); } catch (e) { console.error('routing failed:', e); }
      refresh(); emit('conversation.transferred', { conv: getConv(conv.id), departmentId: dep, by: me });
      return { department_id: dep };
    }
  }
  fail(404, 'Not found');
}

/** Brings snoozed conversations back to the inbox when their time is up. Returns how many woke. */
export function wakeSnoozed() {
  const due = db.prepare('SELECT * FROM conversations WHERE snoozed_until IS NOT NULL AND snoozed_until<=?').all(now());
  for (const conv of due) {
    db.prepare('UPDATE conversations SET snoozed_until=NULL WHERE id=?').run(conv.id);
    addMessage(getConv(conv.id), 'note', '⏰ Snooze ended — this conversation is back in the inbox', { senderName: 'System' });
    emitConv(getConv(conv.id)); emit('conversation.unsnoozed', { conv: getConv(conv.id) });
  }
  return due.length;
}

export default defineModule({
  key: 'livechat', name: 'Live chat', description: 'Chat widget, shared inbox, visitors and saved replies.', core: true,
  init() {
    // Email the visitor an agent's reply when they have left the site
    on('message.created', ({ conv, message }) => {
      if (message.sender !== 'agent' || isOnline(conv.visitor_id)) return;
      const S = getSettings(conv.site_id); if (!S.emailReplies) return;
      emailVisitor(conv.id, `${S.brandName}: ${message.sender_name} replied to your message`, `${message.body}\n\n— ${message.sender_name}, ${S.brandName}`);
    });
    // A visitor writing again wakes a snoozed conversation
    on('message.created', ({ conv, message }) => {
      if (message.sender !== 'visitor' || !conv.snoozed_until) return;
      db.prepare('UPDATE conversations SET snoozed_until=NULL WHERE id=?').run(conv.id); emitConv(getConv(conv.id));
    });
    setInterval(wakeSnoozed, 30_000).unref();
    on('conversation.closed', ({ conv }) => {
      const S = getSettings(conv.site_id);
      if (S.emailTranscript) emailVisitor(conv.id, `Your conversation with ${S.brandName}`, transcriptText(conv.id));
    });
  },
  routes: [
    ...widgetRoutes,
    { method: 'GET', path: '/api/site-key', auth: 'public', handler: c => { if (process.env.DEMO === '0') fail(404, 'Not found'); return { key: db.prepare('SELECT site_key FROM sites ORDER BY id LIMIT 1').get()?.site_key }; } },
    // Any signed-in user may connect: notifications are per user; workspace events are scoped to the member's access.
    { method: 'GET', path: '/api/events', auth: 'user', handler: c => {
      const { req, res, auth } = c;
      sse(res);
      const ws = auth.suspended ? null : c.ws; // suspended workspaces get notifications only
      const entry = { res, userId: c.me.id, ws, sites: auth.siteLimit ? new Set(auth.siteIds) : null, viewAll: c.can('chats.view_all'), canReply: !!ws && c.can('chats.reply') };
      const before = new Map(auth.siteIds.map(id => [id, teamAvailable(id)]));
      agentStreams.add(entry);
      res.write(frame('ready', {}));
      const announce = () => { for (const [id, was] of before) { const nowOn = teamAvailable(id); if (nowOn !== was) toSiteVisitors(id, 'agents', { online: nowOn }); } };
      announce();
      emit('agent.online', { userId: c.me.id, ws });
      req.on('close', () => { for (const id of before.keys()) before.set(id, teamAvailable(id)); agentStreams.delete(entry); announce(); });
    } },
    { method: 'GET', path: '/api/stats', auth: 'ws', perm: 'chats.view', handler: c => {
      const ids = c.scopeSites(), S = c.inSites(ids), one = (q, ...a) => db.prepare(q).get(...a).n;
      const day = new Date(); day.setHours(0, 0, 0, 0);
      let visitorsOnline = 0; for (const k of visitorStreams.keys()) if (ids.includes(Number(k.split(':')[0]))) visitorsOnline++;
      return {
        open: one(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND status='open'`),
        unassigned: one(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND status='open' AND assignee_id IS NULL`),
        needsHuman: one(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND status='open' AND needs_human=1`),
        today: one(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND created>=?`, day.getTime()),
        messagesToday: one(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conv_id WHERE c.site_id IN ${S} AND m.created>=?`, day.getTime()),
        visitorsOnline, agentsOnline: new Set([...agentStreams].filter(s => s.ws === c.ws).map(s => s.userId)).size,
        resolved: one(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND status='closed'`),
      };
    } },
    { method: 'GET', path: '/api/conversations', auth: 'ws', perm: 'chats.view', handler: c => {
      const st = c.query.get('status'), f = c.query.get('filter'), q = c.q('q', 100);
      let sql = `SELECT c.* FROM conversations c JOIN visitors v ON v.id=c.visitor_id WHERE c.workspace_id=? AND c.site_id IN ${c.inSites(c.scopeSites())}`; const args = [c.ws];
      if (!c.can('chats.view_all')) { sql += ' AND (c.assignee_id IS NULL OR c.assignee_id=?)'; args.push(c.me.id); }
      if (st === 'open' || st === 'closed') { sql += ' AND c.status=?'; args.push(st); }
      if (f === 'mine') { sql += ' AND c.assignee_id=?'; args.push(c.me.id); }
      if (f === 'unassigned') sql += ' AND c.assignee_id IS NULL';
      if (f === 'human') sql += ' AND c.needs_human=1';
      // snoozed chats leave the open lists until they wake up (or the visitor writes again)
      if (f === 'snoozed') { sql += ' AND c.snoozed_until IS NOT NULL'; } else if (st !== 'closed') sql += ' AND c.snoozed_until IS NULL';
      const pr = c.query.get('priority'); if (PRIORITIES.includes(pr)) { sql += ' AND c.priority=?'; args.push(pr); }
      const dep = c.query.get('department'); if (dep === 'none') sql += ' AND c.department_id IS NULL'; else if (dep) { sql += ' AND c.department_id=?'; args.push(toInt(dep)); }
      const asg = c.query.get('assignee'); if (asg === 'none') sql += ' AND c.assignee_id IS NULL'; else if (asg) { sql += ' AND c.assignee_id=?'; args.push(toInt(asg)); }
      for (const [k, op] of [['from', '>='], ['to', '<']]) { const t = Number(c.query.get(k)); if (t > 0) { sql += ` AND c.created${op}?`; args.push(t); } }
      if (c.query.get('tag')) { sql += ' AND c.tags LIKE ?'; args.push(`%"${c.q('tag', 24).replace(/[%_"]/g, '')}"%`); }
      if (q) { sql += ' AND (v.name LIKE ? OR v.email LIKE ? OR c.last_body LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      sql += ` ORDER BY c.needs_human DESC, ${PRIORITY_RANK} DESC, c.updated DESC LIMIT 200`;
      return { conversations: db.prepare(sql).all(...args).map(convOut) };
    } },
    { method: 'GET', path: '/api/conversations/:id', auth: 'ws', perm: 'chats.view', handler: c => {
      const conv = loadConv(c, c.int('id'));
      return { conversation: convOut(conv), messages: db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id').all(conv.id).map(msgOut) };
    } },
    { method: 'POST', path: '/api/conversations/bulk', auth: 'ws', perm: 'chats.view', handler: async c => {
      const b = await c.body(), ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger))].slice(0, 200);
      if (!ids.length) fail(400, 'Select at least one conversation');
      const map = {
        close: ['status', { status: 'closed' }], reopen: ['status', { status: 'open' }], read: ['read', {}],
        assign: ['assign', { agent_id: b.value ?? null }], priority: ['priority', { priority: b.value }], department: ['department', { department_id: b.value ?? null }],
        snooze: ['snooze', { until: b.value }], unsnooze: ['snooze', { until: null }],
      };
      if (b.action === 'delete') c.need('chats.delete'); else if (!map[b.action] && b.action !== 'tag') fail(400, 'Unknown bulk action');
      let updated = 0; const errors = [];
      for (const id of ids) {
        let conv; try { conv = loadConv(c, id); } catch { continue; }
        try {
          if (b.action === 'delete') { db.prepare('DELETE FROM conversations WHERE id=?').run(id); toAgents(c.ws, conv.site_id, 'deleted', { id }); }
          else if (b.action === 'tag') await applyAction(c, conv, 'tags', { tags: [...(conv.tags ? JSON.parse(conv.tags) : []), String(b.value || '')] });
          else await applyAction(c, conv, ...map[b.action]);
          updated++;
        } catch (e) { if (e.code === 403) throw e; errors.push(`#${id}: ${e.message}`); }
      }
      if (b.action === 'delete') c.log('conversation.deleted', `${updated} conversations (bulk)`);
      return { updated, errors };
    } },
    { method: 'POST', path: '/api/conversations/:id/:action', match: { action: /^(messages|note|read|typing|status|assign|upload|tags|priority|snooze|department)$/ }, auth: 'ws', perm: 'chats.view', handler: conversationAction },
    { method: 'DELETE', path: '/api/conversations/:id', auth: 'ws', perm: 'chats.delete', handler: c => {
      const conv = loadConv(c, c.int('id'));
      db.prepare('DELETE FROM conversations WHERE id=?').run(conv.id); c.log('conversation.deleted', `#${conv.id}`);
      toAgents(c.ws, conv.site_id, 'deleted', { id: conv.id }); return {};
    } },
    { method: 'GET', path: '/api/conversations/:id/transcript', auth: 'ws', perm: 'chats.view', handler: c => {
      const conv = loadConv(c, c.int('id'));
      c.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="conversation-${conv.id}.txt"` });
      c.res.end(transcriptText(conv.id));
    } },
    { method: 'GET', path: '/api/tags', auth: 'ws', perm: 'chats.view', handler: c => {
      const counts = {}; for (const r of db.prepare(`SELECT tags FROM conversations WHERE workspace_id=? AND site_id IN ${c.inSites(c.auth.siteIds)} AND tags IS NOT NULL`).all(c.ws)) for (const t of JSON.parse(r.tags)) counts[t] = (counts[t] || 0) + 1;
      return { tags: Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) };
    } },
    { method: 'GET', path: '/api/visitors', auth: 'ws', perm: ['chats.view', 'contacts.view'], handler: c => {
      const ids = new Set(c.scopeSites());
      const online = [...visitorStreams.keys()].filter(k => ids.has(Number(k.split(':')[0])));
      const rows = online.length ? db.prepare(`SELECT * FROM visitors WHERE id IN (${online.map(() => '?').join(',')}) ORDER BY last_seen DESC`).all(...online) : [];
      return { visitors: rows.map(v => ({ ...visitorOut(v), site_name: siteRow(v.site_id)?.name })) };
    } },
    // ----- saved inbox views (personal, or shared with the whole team) -----
    { method: 'GET', path: '/api/inbox/views', auth: 'ws', perm: 'chats.view', handler: c => ({
      views: db.prepare('SELECT v.*, u.name owner_name FROM inbox_views v LEFT JOIN users u ON u.id=v.user_id WHERE v.workspace_id=? AND (v.user_id=? OR v.shared=1) ORDER BY v.shared, v.name').all(c.ws, c.me.id)
        .map(v => ({ id: v.id, name: v.name, filters: JSON.parse(v.filters), shared: !!v.shared, mine: v.user_id === c.me.id, owner_name: v.owner_name })) }) },
    { method: 'POST', path: '/api/inbox/views', auth: 'ws', perm: 'chats.view', handler: async c => {
      const b = await c.body(), name = str(b.name, 60); if (!name) fail(400, 'Give the view a name');
      if (b.shared) c.need('settings.manage');
      const f = b.filters || {}, filters = {};
      for (const k of ['status', 'filter', 'q', 'tag', 'priority', 'department', 'assignee']) if (f[k] != null && f[k] !== '') filters[k] = str(String(f[k]), 100);
      if (db.prepare('SELECT COUNT(*) n FROM inbox_views WHERE workspace_id=? AND user_id=?').get(c.ws, c.me.id).n >= 30) fail(400, 'You can save up to 30 views');
      const id = db.prepare('INSERT INTO inbox_views(workspace_id,user_id,name,filters,shared,created) VALUES(?,?,?,?,?,?)').run(c.ws, c.me.id, name, JSON.stringify(filters), b.shared ? 1 : 0, now()).lastInsertRowid;
      return { id: Number(id) };
    } },
    { method: 'DELETE', path: '/api/inbox/views/:id', auth: 'ws', perm: 'chats.view', handler: c => {
      const v = db.prepare('SELECT * FROM inbox_views WHERE id=? AND workspace_id=?').get(c.int('id'), c.ws);
      if (!v || (v.user_id !== c.me.id && !v.shared)) fail(404, 'View not found');
      if (v.user_id !== c.me.id) c.need('settings.manage');
      db.prepare('DELETE FROM inbox_views WHERE id=?').run(v.id); return {};
    } },
    // ----- my availability -----
    { method: 'PUT', path: '/api/me/status', auth: 'user', handler: async c => {
      const st = (await c.body()).status; if (!['available', 'away'].includes(st)) fail(400, 'Status must be available or away');
      const mine = [...agentStreams].filter(s => s.userId === c.me.id && s.ws);
      const sites = new Set(mine.flatMap(s => db.prepare('SELECT id FROM sites WHERE workspace_id=?').all(s.ws).map(r => r.id)));
      const before = new Map([...sites].map(id => [id, teamAvailable(id)]));
      setAway(c.me.id, st === 'away');
      for (const [id, was] of before) { const on = teamAvailable(id); if (on !== was) toSiteVisitors(id, 'agents', { online: on }); }
      for (const ws of new Set(mine.map(s => s.ws))) toAgents(ws, null, 'agent_status', { user_id: c.me.id, status: st });
      emit('agent.status', { userId: c.me.id, status: st, workspaces: [...new Set(mine.map(s => s.ws))] });
      return { status: agentStatus(c.me.id) };
    } },
    { method: 'GET', path: '/api/canned', auth: 'ws', handler: c => ({ canned: db.prepare('SELECT id, shortcut, text FROM canned WHERE workspace_id=? ORDER BY shortcut').all(c.ws) }) },
    { method: 'POST', path: '/api/canned', auth: 'ws', perm: 'canned.manage', handler: async c => {
      const b = await c.body(), sc = str(b.shortcut, 30).toLowerCase().replace(/[^a-z0-9_-]/g, ''), text = str(b.text, 2000);
      if (!sc || !text) fail(400, 'Shortcut and text required');
      try { db.prepare('INSERT INTO canned(workspace_id,shortcut,text) VALUES(?,?,?)').run(c.ws, sc, text); } catch { fail(409, 'Shortcut already exists'); }
      return {};
    } },
    { method: 'DELETE', path: '/api/canned/:id', auth: 'ws', perm: 'canned.manage', handler: c => { db.prepare('DELETE FROM canned WHERE id=? AND workspace_id=?').run(c.int('id'), c.ws); return {}; } },
    { method: 'GET', path: '/api/settings', auth: 'ws', handler: c => ({ settings: getSettings(c.siteParam()) }) },
    { method: 'PUT', path: '/api/settings', auth: 'ws', handler: async c => {
      const sid = c.siteParam(), b = await c.body();
      const botKeys = ['botEnabled', 'aiEnabled', 'aiInstructions'], keys = Object.keys(b);
      if (keys.length === 1 && keys[0] === 'spamFilter') c.need('chats.block', 'settings.manage');
      else if (keys.every(k => botKeys.includes(k))) c.need('bot.manage');
      else c.need('settings.manage');
      if (b.color && !/^#[0-9a-fA-F]{6}$/.test(b.color)) fail(400, 'Color must be a hex value like #4f46e5');
      if (b.position && !['left', 'right'].includes(b.position)) fail(400, 'Bad position');
      if (b.launcherStyle && !['circle', 'pill'].includes(b.launcherStyle)) fail(400, 'Bad launcher style');
      if (b.theme && !['light', 'dark', 'auto'].includes(b.theme)) fail(400, 'Bad theme');
      if (b.spamFilter && !['off', 'normal', 'strict'].includes(b.spamFilter)) fail(400, 'Spam filter must be off, normal or strict');
      if (b.avatarUrl && !/^https?:\/\/|^\//.test(b.avatarUrl)) fail(400, 'Avatar must be an http(s) URL');
      if ('proactiveDelay' in b) b.proactiveDelay = Math.max(0, Math.min(600, Number(b.proactiveDelay) || 0));
      if ('slaMinutes' in b) b.slaMinutes = Math.max(0, Math.min(1440, Math.round(Number(b.slaMinutes)) || 0));
      for (const k of BOOL_SETTINGS) if (k in b) b[k] = !!b[k];
      for (const k of TEXT_SETTINGS) if (k in b) b[k] = str(b[k], 500);
      if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { fail(400, 'Unknown timezone'); } }
      for (const k of ['hoursStart', 'hoursEnd']) if (b[k] && !/^\d\d:\d\d$/.test(b[k])) fail(400, 'Times must look like 09:00');
      if (b.webhookUrl && !/^https?:\/\//.test(b.webhookUrl)) fail(400, 'Webhook URL must start with http(s)://');
      setSettings(sid, b); c.log('settings.updated', `${siteRow(sid).name}: ${keys.join(', ')}`);
      return { settings: getSettings(sid) };
    } },
    { method: 'POST', path: '/api/mail/test', auth: 'ws', perm: 'settings.manage', handler: async c => {
      try { await sendMail({ to: c.me.email, subject: 'Chatly test email', text: 'Email delivery from Chatly is working.' }); } catch (e) { fail(400, e.message); }
      return {};
    } },
  ],
});
