import { db } from '../../core/db.js';
import { fail, str } from '../../core/http.js';
import { defineModule } from '../../core/modules.js';

function triggerFields(b) {
  const name = str(b.name, 80), message = str(b.message, 500);
  if (!name || !message) fail(400, 'Name and message are required');
  return { name, message, url: str(b.url_contains, 200), delay: Math.max(0, Math.min(600, Math.round(Number(b.delay)) || 0)), open: b.open_chat ? 1 : 0, enabled: b.enabled === false ? 0 : 1 };
}
/** Triggers the widget should run for a website (empty when the module is off). */
export const widgetTriggers = siteId => db.prepare('SELECT id,url_contains,delay,message,open_chat FROM triggers WHERE site_id=? AND enabled=1').all(siteId).map(t => ({ ...t, open_chat: !!t.open_chat }));
export const triggerMessage = (id, siteId) => db.prepare('SELECT message FROM triggers WHERE id=? AND site_id=?').get(Number(id), siteId)?.message;

export default defineModule({
  key: 'triggers', name: 'Triggers', description: 'Proactive messages by page URL and delay, or auto-open the chat.',
  routes: [
    { method: 'GET', path: '/api/triggers', auth: 'ws', handler: c => ({ triggers: db.prepare('SELECT * FROM triggers WHERE site_id=? ORDER BY id').all(c.siteParam()).map(t => ({ ...t, open_chat: !!t.open_chat, enabled: !!t.enabled })) }) },
    { method: 'POST', path: '/api/triggers', auth: 'ws', perm: 'bot.manage', handler: async c => {
      const sid = c.siteParam(), t = triggerFields(await c.body());
      return { id: db.prepare('INSERT INTO triggers(site_id,name,url_contains,delay,message,open_chat,enabled) VALUES(?,?,?,?,?,?,?)').run(sid, t.name, t.url, t.delay, t.message, t.open, t.enabled).lastInsertRowid };
    } },
    { method: 'PUT', path: '/api/triggers/:id', auth: 'ws', perm: 'bot.manage', handler: async c => {
      const sid = c.siteParam(), t = triggerFields(await c.body());
      db.prepare('UPDATE triggers SET name=?,url_contains=?,delay=?,message=?,open_chat=?,enabled=? WHERE id=? AND site_id=?').run(t.name, t.url, t.delay, t.message, t.open, t.enabled, c.int('id'), sid); return {};
    } },
    { method: 'DELETE', path: '/api/triggers/:id', auth: 'ws', perm: 'bot.manage', handler: c => { db.prepare('DELETE FROM triggers WHERE id=? AND site_id=?').run(c.int('id'), c.siteParam()); return {}; } },
  ],
});
