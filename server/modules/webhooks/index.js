/** Webhooks: forwards domain events to each website's webhook URL (Zapier, Make, n8n, your backend). */
import { now, getSettings } from '../../core/db.js';
import { on } from '../../core/events.js';
import { defineModule, isEnabled } from '../../core/modules.js';
import { convOut, visitorOut, getVisitor } from '../livechat/service.js';
import { ticketOut } from '../tickets/service.js';

function post(siteId, ws, event, data) {
  if (!isEnabled(ws, 'webhooks')) return;
  const url = getSettings(siteId).webhookUrl; if (!/^https?:\/\//.test(url)) return;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Chatly-Webhooks/1' }, body: JSON.stringify({ event, site_id: siteId, time: now(), data }), signal: AbortSignal.timeout(8000) }).catch(() => {});
}

export default defineModule({
  key: 'webhooks', name: 'Webhooks', description: 'Send conversation, message, contact, rating and ticket events to your own URL.',
  init() {
    on('conversation.created', ({ conv }) => post(conv.site_id, conv.workspace_id, 'conversation.created', convOut(conv)));
    on('message.created', ({ conv, message }) => {
      if (message.sender === 'visitor') post(conv.site_id, conv.workspace_id, 'message.created', { conversation_id: conv.id, sender: 'visitor', body: message.body, visitor: visitorOut(getVisitor(conv.visitor_id)) });
      else if (message.sender === 'agent') post(conv.site_id, conv.workspace_id, 'message.created', { conversation_id: conv.id, sender: 'agent', body: message.body });
    });
    on('visitor.identified', ({ visitor }) => post(visitor.site_id, getVisitorWs(visitor), 'visitor.identified', visitorOut(visitor)));
    on('conversation.closed', ({ conv }) => post(conv.site_id, conv.workspace_id, 'conversation.closed', { conversation_id: conv.id }));
    // tickets: sent to the ticket's website, or the workspace's first website when it has none (e.g. email tickets)
    const tsite = t => t.site_id || db.prepare('SELECT id FROM sites WHERE workspace_id=? ORDER BY id LIMIT 1').get(t.workspace_id)?.id;
    for (const ev of ['ticket.created', 'ticket.updated', 'ticket.solved']) on(ev, ({ ticket, changes }) => { const s = tsite(ticket); if (s) post(s, ticket.workspace_id, ev, { ...ticketOut(ticket), ...(changes && { changes }) }); });
    on('ticket.message', ({ ticket, message }) => { const s = tsite(ticket); if (s && message.kind === 'public') post(s, ticket.workspace_id, 'ticket.message', { ticket_id: ticket.id, number: ticket.number, author_type: message.author_type, body: message.body }); });
    on('conversation.rated', ({ conv, rating }) => post(conv.site_id, conv.workspace_id, 'conversation.rated', { conversation_id: conv.id, rating }));
  },
});
import { db } from '../../core/db.js';
const getVisitorWs = v => db.prepare('SELECT workspace_id FROM sites WHERE id=?').get(v.site_id)?.workspace_id;
