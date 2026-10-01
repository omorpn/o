import { S, api, beep, toast, vname } from './core.js';
import { debounce, drawHead, drawList, drawMessages, drawSide, drawTags, drawTyping, loadConvs } from './inbox.js';
import { boot, refreshNavBadge, renderShell } from './shell.js';
import { drawVisitors } from './visitors.js';
import { onNotification, onReadSync } from './notifications.js';
import { onTicket, onTicketMessage, onTicketDeleted } from './tickets.js';

export let es;
// ---------- realtime ----------
/** Re-reads my access after a reconnect: roles, websites or membership may have changed. */
export async function checkAccess() {
  const d = await api('/me').catch(() => null); if (!d?.user) return;
  const sig = x => JSON.stringify([x.workspace?.id, [...(x.permissions || x.perms || [])].sort(), (x.sites || []).map(s => s.id)]);
  if (sig(d) !== sig({ workspace: S.workspace, permissions: [...S.perms], sites: S.sites })) { toast('Your access was updated'); boot(); }
}
export function connect() {
  if (es) es.close();
  es = new EventSource('/api/events');
  let first = true;
  es.addEventListener('ready', () => { if (!first) checkAccess(); first = false; if (S.view === 'inbox') loadConvs(); });
  es.onerror = debounce(checkAccess, 3000);
  es.addEventListener('notification', e => onNotification(JSON.parse(e.data)));
  es.addEventListener('notifications.read', e => onReadSync(JSON.parse(e.data)));
  es.addEventListener('message', e => {
    const { conv, message } = JSON.parse(e.data);
    S.convs.set(conv.id, conv);
    if (S.cur === conv.id) {
      if (!S.msgs.some(m => m.id === message.id)) S.msgs.push(message);
      if (message.sender === 'visitor' && document.hasFocus()) { api(`/conversations/${conv.id}/read`, 'POST').catch(() => {}); conv.unread = 0; }
      S.typing[conv.visitor.id] = 0;
      if (S.view === 'inbox') { drawMessages(); drawList(); drawSide(); drawHead(); }
    } else if (S.view === 'inbox') drawList();
    if (message.sender === 'visitor' && (S.cur !== conv.id || !document.hasFocus())) {
      beep();
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(vname(conv.visitor), { body: message.body });
    }
    refreshNavBadge();
  });
  es.addEventListener('conversation', e => {
    const c = JSON.parse(e.data); S.convs.set(c.id, c);
    if (S.view === 'inbox') { drawList(); if (S.cur === c.id) { drawHead(); drawSide(); const tb = document.getElementById('tagbar'); if (tb && !tb.contains(document.activeElement)) drawTags(); } }
    refreshNavBadge();
  });
  es.addEventListener('deleted', e => { const { id } = JSON.parse(e.data); S.convs.delete(id); if (S.cur === id) { S.cur = null; } if (S.view === 'inbox') renderShell(); });
  es.addEventListener('ticket', e => onTicket(JSON.parse(e.data)));
  es.addEventListener('ticket_message', e => onTicketMessage(JSON.parse(e.data)));
  es.addEventListener('ticket_deleted', e => onTicketDeleted(JSON.parse(e.data)));
  es.addEventListener('message_status', e => { const { conv_id, id, delivery } = JSON.parse(e.data); const m = S.cur === conv_id && S.msgs.find(x => x.id === id); if (m) { m.delivery = delivery; if (S.view === 'inbox') drawMessages(); } });
  es.addEventListener('agent_status', e => { const { user_id, status } = JSON.parse(e.data); const m = S.members.find(x => x.id === user_id); if (m) m.status = status; if (user_id === S.me.id && S.me.status !== status) { S.me.status = status; renderShell(); } });
  es.addEventListener('presence', e => {
    const p = JSON.parse(e.data);
    if (p.online) S.visitors.set(p.visitor_id, p.visitor); else S.visitors.delete(p.visitor_id);
    for (const c of S.convs.values()) if (c.visitor.id === p.visitor_id) { c.visitor.online = p.online; if (p.visitor) Object.assign(c.visitor, p.visitor, { online: p.online }); }
    if (S.view === 'inbox') { drawList(); drawSide(); drawHead(); } else if (S.view === 'visitors') drawVisitors();
  });
  es.addEventListener('typing', e => {
    const { visitor_id } = JSON.parse(e.data); S.typing[visitor_id] = Date.now();
    if (S.view === 'inbox') drawTyping();
    setTimeout(() => S.view === 'inbox' && drawTyping(), 3100);
  });
}

