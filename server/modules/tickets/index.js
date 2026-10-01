/**
 * Tickets: issues that need follow-up beyond a live chat — created by agents, from a chat, or by inbound email.
 * Statuses open → pending (waiting on the customer) → solved → closed (automatically after N days), priorities with
 * first-response and resolution SLA targets, assignee, department, tags, custom fields, internal notes, merge,
 * a full change history, bulk actions, realtime updates and notifications.
 */
import { db, now, getWsSettings, setWsSettings, once } from '../../core/db.js';
import { fail, str, toInt, EMAIL } from '../../core/http.js';
import { on } from '../../core/events.js';
import { defineModule, isEnabled } from '../../core/modules.js';
import { memberOf, memberPerms, membersWith } from '../../core/auth.js';
import { TICKET_DEFAULTS } from '../../core/rbac.js';
import { TYPES, notify } from '../notifications/index.js';
import { loadConv } from '../livechat/index.js';
import { getVisitor, addMessage, getConv, transcriptText, validDepartment } from '../livechat/service.js';
import { STATUSES, PRIORITIES, FIELD_TYPES, SLA_DEFAULTS, getTicket, ticketOut, messageOut, logEvent, cleanCustom, cleanTags, addTicketMessage, createTicket, updateTicket,
  autoClose, broadcast, broadcastDeleted } from './service.js';

// ---------- access ----------
/** SQL fragment + args limiting tickets to what the current member may see. */
function scope(c, alias = 't') {
  let sql = `${alias}.workspace_id=? AND ${alias}.merged_into IS NULL`; const args = [c.ws];
  if (!c.can('tickets.view_all')) { sql += ` AND (${alias}.assignee_id IS NULL OR ${alias}.assignee_id=?)`; args.push(c.me.id); }
  if (c.auth.siteLimit) sql += ` AND (${alias}.site_id IS NULL OR ${alias}.site_id IN ${c.inSites(c.auth.siteIds)})`;
  return { sql, args };
}
export function loadTicket(c, id) {
  const t = getTicket(id);
  if (!t || t.workspace_id !== c.ws || (t.site_id && !c.auth.siteIds.includes(t.site_id))) fail(404, 'Ticket not found');
  if (!c.can('tickets.view_all') && t.assignee_id && t.assignee_id !== c.me.id) fail(404, 'Ticket not found');
  return t;
}
function checkAssignee(ws, uid) {
  if (uid == null) return null;
  const mem = memberOf(toInt(uid), ws);
  if (!mem || !memberPerms(mem).has('tickets.reply')) fail(400, "That teammate's role can't work on tickets");
  return toInt(uid);
}
const OVERDUE = t => `${t}.status IN ('open','pending') AND ((${t}.first_response_at IS NULL AND ${t}.first_response_due < ?) OR ${t}.due_at < ?)`;

/** Turns request fields into a validated patch for updateTicket(). */
function patchFrom(c, t, b) {
  const p = {};
  if ('subject' in b) { p.subject = str(b.subject, 200); if (!p.subject) fail(400, 'Subject is required'); }
  if ('status' in b) { if (!STATUSES.includes(b.status)) fail(400, 'Status must be open, pending, solved or closed'); p.status = b.status; }
  if ('priority' in b) { if (!PRIORITIES.includes(b.priority)) fail(400, 'Priority must be low, normal, high or urgent'); p.priority = b.priority; }
  if ('assignee_id' in b) { if (b.assignee_id !== c.me.id && b.assignee_id !== t?.assignee_id) c.need('chats.assign', 'tickets.manage'); p.assignee_id = checkAssignee(c.ws, b.assignee_id); }
  if ('department_id' in b) { p.department_id = b.department_id == null ? null : validDepartment(c.ws, b.department_id); if (b.department_id != null && !p.department_id) fail(400, 'Unknown department'); }
  if ('tags' in b) p.tags = cleanTags(b.tags);
  if ('custom' in b) p.custom = cleanCustom(c.ws, b.custom, t?.custom ? JSON.parse(t.custom) : {});
  if (t?.status === 'closed' && Object.keys(p).some(k => k !== 'status') && p.status !== 'open') fail(400, 'Closed tickets are read-only — reopen it first');
  return p;
}

// ---------- notifications ----------
Object.assign(TYPES, {
  'ticket.new': { group: 'Tickets', label: 'New ticket', description: 'A ticket is created in a department you belong to (or anywhere, if it has none)', in_app: 1, email: 0, push: 0 },
  'ticket.assigned': { group: 'Tickets', label: 'Ticket assigned to me', description: 'Someone assigns a ticket to you', in_app: 1, email: 1, push: 1 },
  'ticket.reply': { group: 'Tickets', label: 'Customer replied', description: 'The customer replies on a ticket assigned to you', in_app: 1, email: 1, push: 1 },
  'ticket.sla': { group: 'Tickets', label: 'Ticket SLA breached', description: 'A ticket missed its first-response or resolution target', in_app: 1, email: 1, push: 1 },
});
/** Teammates who should hear about an unassigned ticket: its department, else everyone who can see tickets on that site. */
function ticketWatchers(t) {
  let list = membersWith(t.workspace_id, 'tickets.view', t.site_id || null);
  if (t.department_id && isEnabled(t.workspace_id, 'departments')) {
    const dept = new Set(db.prepare('SELECT user_id FROM department_members WHERE department_id=?').all(t.department_id).map(r => r.user_id));
    if (dept.size) list = list.filter(m => dept.has(m.id));
  }
  return list.map(m => m.id);
}
const tlink = t => `tickets/${t.workspace_id}/${t.id}`;
const tname = t => `#${t.number} ${t.subject}`.slice(0, 120);

/** Notifies once per breach kind (first response, resolution). Returns how many tickets alerted. */
export function runTicketSla() {
  let sent = 0;
  for (const t of db.prepare(`SELECT * FROM tickets t WHERE merged_into IS NULL AND ${OVERDUE('t')}`).all(now(), now())) {
    if (!isEnabled(t.workspace_id, 'tickets')) continue;
    const kind = !t.first_response_at && t.first_response_due < now() ? 'first' : 'resolve';
    const done = (t.sla_notified || '').split(',');
    if (done.includes(kind)) continue;
    db.prepare('UPDATE tickets SET sla_notified=? WHERE id=?').run([...done.filter(Boolean), kind].join(','), t.id);
    logEvent(t.id, null, 'sla_breached', kind === 'first' ? 'First-response target missed' : 'Resolution target missed');
    const to = t.assignee_id ? [t.assignee_id, ...membersWith(t.workspace_id, 'tickets.view_all', t.site_id || null).filter(m => m.system).map(m => m.id)] : ticketWatchers(t);
    notify(to, { type: 'ticket.sla', ws: t.workspace_id, link: tlink(t), urgent: true, skipOnline: false, throttleKey: `t${t.id}${kind}`,
      title: `SLA breached: ${tname(t)}`, body: kind === 'first' ? 'No first response yet' : 'Not resolved in time' });
    broadcast(getTicket(t.id)); sent++;
  }
  return sent;
}

// ---------- module ----------
export default defineModule({
  key: 'tickets', name: 'Tickets', description: 'Track issues to resolution: statuses, priorities, SLA targets, assignment, custom fields, merge and history.',
  init() {
    // Roles created before tickets existed get the same ticket permissions as the new defaults.
    once('ticket-permissions', () => {
      for (const r of db.prepare('SELECT id, name, permissions FROM roles WHERE system=0').all()) {
        const perms = JSON.parse(r.permissions); if (!TICKET_DEFAULTS[r.name] || perms.some(p => p.startsWith('tickets.'))) continue;
        db.prepare('UPDATE roles SET permissions=? WHERE id=?').run(JSON.stringify([...perms, ...TICKET_DEFAULTS[r.name]]), r.id);
      }
    });
    on('ticket.created', ({ ticket, by }) => {
      if (ticket.assignee_id) return;
      notify(ticketWatchers(ticket).filter(id => id !== by?.id), { type: 'ticket.new', ws: ticket.workspace_id, link: tlink(ticket), title: `New ticket ${tname(ticket)}`, body: `From ${ticket.requester_name || ticket.requester_email || 'a teammate'} via ${ticket.channel}` });
    });
    on('ticket.assigned', ({ ticket, assigneeId, by }) => notify([assigneeId], { type: 'ticket.assigned', ws: ticket.workspace_id, link: tlink(ticket),
      title: `${by?.name || 'Someone'} assigned you ${tname(ticket)}`, body: ticket.requester_email ? `Requester: ${ticket.requester_name || ''} <${ticket.requester_email}>` : null }));
    on('ticket.message', ({ ticket, message }) => {
      if (message.author_type !== 'customer' || ticket.status === 'closed') return;
      if (db.prepare('SELECT COUNT(*) n FROM ticket_messages WHERE ticket_id=?').get(ticket.id).n === 1) return; // the opening message is covered by ticket.new
      notify(ticket.assignee_id ? [ticket.assignee_id] : ticketWatchers(ticket), { type: 'ticket.reply', ws: ticket.workspace_id, link: tlink(ticket), throttleKey: 't' + ticket.id, throttleMs: 120_000,
        title: `${message.author_name || 'Customer'} replied on ${tname(ticket)}`, body: message.body.slice(0, 200) });
    });
    setInterval(() => { autoClose(); runTicketSla(); }, Number(process.env.SLA_CHECK_MS) || 60_000).unref();
  },
  routes: [
    { method: 'GET', path: '/api/tickets', auth: 'ws', perm: 'tickets.view', handler: c => {
      const base = scope(c);
      let sql = `SELECT t.* FROM tickets t WHERE ${base.sql}`; const args = [...base.args];
      const st = c.query.get('status') || 'active', view = c.query.get('view');
      if (STATUSES.includes(st)) { sql += ' AND t.status=?'; args.push(st); } else if (st === 'active') sql += " AND t.status IN ('open','pending')";
      if (view === 'mine') { sql += ' AND t.assignee_id=?'; args.push(c.me.id); }
      if (view === 'unassigned') sql += ' AND t.assignee_id IS NULL';
      if (view === 'overdue') { sql += ` AND ${OVERDUE('t')}`; args.push(now(), now()); }
      const pr = c.query.get('priority'); if (PRIORITIES.includes(pr)) { sql += ' AND t.priority=?'; args.push(pr); }
      const asg = c.query.get('assignee'); if (asg === 'none') sql += ' AND t.assignee_id IS NULL'; else if (asg) { sql += ' AND t.assignee_id=?'; args.push(toInt(asg)); }
      const dep = c.query.get('department'); if (dep === 'none') sql += ' AND t.department_id IS NULL'; else if (dep) { sql += ' AND t.department_id=?'; args.push(toInt(dep)); }
      if (c.query.get('tag')) { sql += ' AND t.tags LIKE ?'; args.push(`%"${c.q('tag', 24).replace(/[%_"]/g, '')}"%`); }
      if (c.query.get('conversation')) { sql += ' AND t.conversation_id=?'; args.push(toInt(c.query.get('conversation'))); }
      const q = c.q('q', 100);
      if (q) { const n = Number(q.replace(/^#/, '')); sql += ' AND (t.subject LIKE ? OR t.requester_email LIKE ? OR t.requester_name LIKE ? OR t.number=?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`, Number.isInteger(n) ? n : -1); }
      sql += " ORDER BY CASE t.priority WHEN 'urgent' THEN 3 WHEN 'high' THEN 2 WHEN 'low' THEN 0 ELSE 1 END DESC, t.updated DESC LIMIT 300";
      const one = (extra, ...a) => db.prepare(`SELECT COUNT(*) n FROM tickets t WHERE ${base.sql} AND ${extra}`).get(...base.args, ...a).n;
      return { tickets: db.prepare(sql).all(...args).map(t => ticketOut(t)),
        counts: { open: one("t.status='open'"), pending: one("t.status='pending'"), solved: one("t.status='solved'"), mine: one("t.status IN ('open','pending') AND t.assignee_id=?", c.me.id),
          unassigned: one("t.status IN ('open','pending') AND t.assignee_id IS NULL"), overdue: one(OVERDUE('t'), now(), now()) } };
    } },
    { method: 'POST', path: '/api/tickets', auth: 'ws', perm: 'tickets.reply', handler: async c => {
      const b = await c.body(), subject = str(b.subject, 200), body = str(b.body, 20000);
      if (!subject) fail(400, 'Subject is required');
      const email = str(b.requester_email, 200).toLowerCase(); if (email && !EMAIL.test(email)) fail(400, 'Requester email is invalid');
      const p = patchFrom(c, null, { priority: b.priority || 'normal', ...('assignee_id' in b && { assignee_id: b.assignee_id }), ...('department_id' in b && { department_id: b.department_id }), tags: b.tags || [], custom: b.custom || {} });
      const siteId = b.site_id ? (c.auth.siteIds.includes(Number(b.site_id)) ? Number(b.site_id) : fail(400, 'Unknown website')) : (c.auth.siteLimit ? c.auth.siteIds[0] ?? null : null);
      const t = createTicket({ ws: c.ws, subject, body, priority: p.priority, channel: 'manual', requesterName: str(b.requester_name, 100) || null, requesterEmail: email || null, siteId,
        assigneeId: p.assignee_id ?? null, departmentId: p.department_id ?? null, tags: p.tags, custom: p.custom, user: c.me, authorType: email ? 'customer' : 'agent' });
      return { ticket: ticketOut(t) };
    } },
    { method: 'POST', path: '/api/conversations/:id/ticket', auth: 'ws', perm: ['tickets.reply'], handler: async c => {
      c.need('chats.view'); const conv = loadConv(c, c.int('id')), b = await c.body(), v = getVisitor(conv.visitor_id);
      const lastVisitor = db.prepare("SELECT body FROM messages WHERE conv_id=? AND sender='visitor' ORDER BY id DESC LIMIT 1").get(conv.id)?.body || 'Follow-up from chat';
      const p = patchFrom(c, null, { priority: b.priority || conv.priority || 'normal', ...('assignee_id' in b ? { assignee_id: b.assignee_id } : { assignee_id: c.me.id }), department_id: b.department_id ?? conv.department_id ?? null });
      const t = createTicket({ ws: c.ws, subject: str(b.subject, 200) || lastVisitor.slice(0, 120), body: null, priority: p.priority, channel: 'chat', requesterName: v?.name || null, requesterEmail: v?.email || null,
        siteId: conv.site_id, conversationId: conv.id, visitorId: conv.visitor_id, assigneeId: p.assignee_id, departmentId: p.department_id, tags: conv.tags ? JSON.parse(conv.tags) : [], user: c.me });
      addTicketMessage(t, { kind: 'note', authorType: 'system', authorName: 'Chat transcript', body: (str(b.note, 4000) ? str(b.note, 4000) + '\n\n' : '') + transcriptText(conv.id) });
      addMessage(getConv(conv.id), 'note', `🎫 ${c.me.name} created ticket #${t.number}: ${t.subject}`, { senderId: c.me.id, senderName: c.me.name });
      return { ticket: ticketOut(getTicket(t.id)) };
    } },
    { method: 'GET', path: '/api/tickets/settings', auth: 'ws', perm: 'tickets.view', handler: c => { const s = getWsSettings(c.ws); return { sla: s.ticketSla, autoCloseDays: s.ticketAutoCloseDays, fields: s.ticketFields }; } },
    { method: 'PUT', path: '/api/tickets/settings', auth: 'ws', perm: 'tickets.manage', handler: async c => {
      const b = await c.body(), patch = {};
      if (b.sla) {
        patch.ticketSla = {};
        for (const p of PRIORITIES) {
          const [f, r] = Array.isArray(b.sla[p]) ? b.sla[p].map(Number) : SLA_DEFAULTS[p];
          if (!(f >= 0 && f <= 720 && r >= 0 && r <= 2160)) fail(400, 'SLA hours must be between 0 and 720 (first response) / 2160 (resolution)');
          patch.ticketSla[p] = [f, r];
        }
      }
      if ('autoCloseDays' in b) patch.ticketAutoCloseDays = Math.max(0, Math.min(90, Math.round(Number(b.autoCloseDays)) || 0));
      if ('fields' in b) {
        if (!Array.isArray(b.fields) || b.fields.length > 20) fail(400, 'Up to 20 custom fields');
        const keys = new Set();
        patch.ticketFields = b.fields.map(f => {
          const label = str(f?.label, 40), key = str(f?.key || label, 30).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
          if (!label || !key) fail(400, 'Every field needs a label'); if (keys.has(key)) fail(400, `Duplicate field "${label}"`); keys.add(key);
          if (!FIELD_TYPES.includes(f.type)) fail(400, `Field "${label}" has an unknown type`);
          const options = f.type === 'select' ? [...new Set((Array.isArray(f.options) ? f.options : String(f.options || '').split(',')).map(o => str(String(o), 40)).filter(Boolean))].slice(0, 30) : undefined;
          if (f.type === 'select' && !options.length) fail(400, `Field "${label}" needs options`);
          return { key, label, type: f.type, ...(options && { options }) };
        });
      }
      setWsSettings(c.ws, patch); c.log('tickets.settings', Object.keys(patch).join(', '));
      const s = getWsSettings(c.ws); return { sla: s.ticketSla, autoCloseDays: s.ticketAutoCloseDays, fields: s.ticketFields };
    } },
    { method: 'POST', path: '/api/tickets/bulk', auth: 'ws', perm: 'tickets.view', handler: async c => {
      const b = await c.body(), ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger))].slice(0, 200);
      if (!ids.length) fail(400, 'Select at least one ticket');
      const field = { status: 'status', priority: 'priority', assign: 'assignee_id', department: 'department_id' }[b.action];
      if (b.action === 'delete') c.need('tickets.manage'); else if (field || b.action === 'tag') c.need('tickets.reply'); else fail(400, 'Unknown bulk action');
      let updated = 0; const errors = [];
      for (const id of ids) {
        let t; try { t = loadTicket(c, id); } catch { continue; }
        try {
          if (b.action === 'delete') { db.prepare('DELETE FROM tickets WHERE id=?').run(id); broadcastDeleted(t); }
          else if (b.action === 'tag') updateTicket(t, patchFrom(c, t, { tags: [...(t.tags ? JSON.parse(t.tags) : []), b.value] }), c.me);
          else updateTicket(t, patchFrom(c, t, { [field]: b.value ?? null }), c.me);
          updated++;
        } catch (e) { if (e.code === 403) throw e; errors.push(`#${t.number}: ${e.message}`); }
      }
      if (b.action === 'delete') c.log('ticket.deleted', `${updated} tickets (bulk)`);
      return { updated, errors };
    } },
    { method: 'GET', path: '/api/tickets/:id', auth: 'ws', perm: 'tickets.view', handler: c => {
      const t = loadTicket(c, c.int('id'));
      return { ticket: ticketOut(t, { full: true }), messages: db.prepare('SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY id').all(t.id).map(messageOut),
        events: db.prepare('SELECT * FROM ticket_events WHERE ticket_id=? ORDER BY id').all(t.id),
        merged: db.prepare('SELECT id, number, subject FROM tickets WHERE merged_into=?').all(t.id),
        others: t.requester_email ? db.prepare("SELECT id, number, subject, status, created FROM tickets WHERE workspace_id=? AND requester_email=? AND id!=? AND merged_into IS NULL ORDER BY id DESC LIMIT 10").all(c.ws, t.requester_email, t.id) : [] };
    } },
    { method: 'PUT', path: '/api/tickets/:id', auth: 'ws', perm: 'tickets.reply', handler: async c => {
      const t = loadTicket(c, c.int('id'));
      return { ticket: ticketOut(updateTicket(t, patchFrom(c, t, await c.body()), c.me)) };
    } },
    { method: 'POST', path: '/api/tickets/:id/reply', auth: 'ws', perm: 'tickets.reply', handler: async c => {
      const t = loadTicket(c, c.int('id')), b = await c.body(), body = str(b.body, 20000);
      if (!body) fail(400, 'Write a reply first');
      if (t.status === 'closed') fail(400, 'Closed tickets are read-only — reopen it first');
      if (!b.note && !t.requester_email) fail(400, 'This ticket has no requester email to reply to — add an internal note instead');
      const m = addTicketMessage(t, { kind: b.note ? 'note' : 'public', authorType: 'agent', user: c.me, body });
      // a public reply usually means "waiting on the customer"; the agent can pick another status
      const next = b.status ?? (b.note ? null : t.status === 'open' ? 'pending' : null);
      const patch = next ? patchFrom(c, t, { status: next }) : {};
      if (!b.note && !t.assignee_id) patch.assignee_id = c.me.id;
      const fresh = updateTicket(getTicket(t.id), patch, c.me);
      return { message: m, ticket: ticketOut(fresh) };
    } },
    { method: 'POST', path: '/api/tickets/:id/merge', auth: 'ws', perm: 'tickets.manage', handler: async c => {
      const src = loadTicket(c, c.int('id')), b = await c.body();
      const target = loadTicket(c, toInt(b.into));
      if (src.id === target.id) fail(400, "A ticket can't be merged into itself");
      if (target.merged_into) fail(400, 'That ticket was itself merged into another one');
      db.prepare('UPDATE ticket_messages SET ticket_id=? WHERE ticket_id=?').run(target.id, src.id);
      db.prepare('UPDATE tickets SET merged_into=?, status=?, closed_at=?, updated=? WHERE id=?').run(target.id, 'closed', now(), now(), src.id);
      db.prepare('UPDATE tickets SET merged_into=? WHERE merged_into=?').run(target.id, src.id);
      logEvent(src.id, c.me, 'merged', `Merged into #${target.number}`);
      logEvent(target.id, c.me, 'merged', `#${src.number} “${src.subject}” merged into this ticket`);
      addTicketMessage(getTicket(target.id), { kind: 'note', authorType: 'system', authorName: 'System', body: `Ticket #${src.number} “${src.subject}” was merged into this ticket by ${c.me.name}.` });
      broadcastDeleted(src); c.log('ticket.merged', `#${src.number} → #${target.number}`);
      return { ticket: ticketOut(getTicket(target.id)) };
    } },
    { method: 'DELETE', path: '/api/tickets/:id', auth: 'ws', perm: 'tickets.manage', handler: c => {
      const t = loadTicket(c, c.int('id'));
      db.prepare('DELETE FROM tickets WHERE id=?').run(t.id); broadcastDeleted(t); c.log('ticket.deleted', `#${t.number} ${t.subject}`); return {};
    } },
  ],
});
