/** Webhooks: forwards domain events to each website's webhook URL (Zapier, Make, n8n, your backend). */
import { now, getSettings } from '../../core/db.js';
import { on } from '../../core/events.js';
import { defineModule, isEnabled } from '../../core/modules.js';
import { convOut, visitorOut, getVisitor } from '../livechat/service.js';

function post(siteId, ws, event, data) {
  if (!isEnabled(ws, 'webhooks')) return;
  const url = getSettings(siteId).webhookUrl; if (!/^https?:\/\//.test(url)) return;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Chatly-Webhooks/1' }, body: JSON.stringify({ event, site_id: siteId, time: now(), data }), signal: AbortSignal.timeout(8000) }).catch(() => {});
}

export default defineModule({
  key: 'webhooks', name: 'Webhooks', description: 'Send conversation, message, contact and rating events to your own URL.',
  init() {
    on('conversation.created', ({ conv }) => post(conv.site_id, conv.workspace_id, 'conversation.created', convOut(conv)));
    on('message.created', ({ conv, message }) => {
      if (message.sender === 'visitor') post(conv.site_id, conv.workspace_id, 'message.created', { conversation_id: conv.id, sender: 'visitor', body: message.body, visitor: visitorOut(getVisitor(conv.visitor_id)) });
      else if (message.sender === 'agent') post(conv.site_id, conv.workspace_id, 'message.created', { conversation_id: conv.id, sender: 'agent', body: message.body });
    });
    on('visitor.identified', ({ visitor }) => post(visitor.site_id, getVisitorWs(visitor), 'visitor.identified', visitorOut(visitor)));
    on('conversation.closed', ({ conv }) => post(conv.site_id, conv.workspace_id, 'conversation.closed', { conversation_id: conv.id }));
    on('conversation.rated', ({ conv, rating }) => post(conv.site_id, conv.workspace_id, 'conversation.rated', { conversation_id: conv.id, rating }));
  },
});
import { db } from '../../core/db.js';
const getVisitorWs = v => db.prepare('SELECT workspace_id FROM sites WHERE id=?').get(v.site_id)?.workspace_id;
