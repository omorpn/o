/** Contacts: everyone who left a name or email, their notes and conversation history; CSV export. */
import { db } from '../../core/db.js';
import { fail, str, EMAIL } from '../../core/http.js';
import { defineModule } from '../../core/modules.js';
import { isOnline } from '../../core/realtime.js';
import { visitorOut, convOut, siteRow, emitPresence, getVisitor } from '../livechat/service.js';

const csv = v => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
function loadContact(c) {
  const v = getVisitor(c.params.id);
  if (!v || !c.auth.siteIds.includes(v.site_id)) fail(404, 'Contact not found');
  return v;
}

export default defineModule({
  key: 'contacts', name: 'Contacts', description: 'Contact list with notes, history and CSV export.',
  routes: [
    { method: 'GET', path: '/api/contacts', auth: 'ws', perm: 'contacts.view', handler: c => {
      const q = c.q('q', 100);
      const rows = db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM conversations c WHERE c.visitor_id=v.id) convs FROM visitors v
        WHERE v.site_id IN ${c.inSites(c.scopeSites())} AND (v.email IS NOT NULL OR v.name IS NOT NULL) AND (?='' OR v.name LIKE ? OR v.email LIKE ?) ORDER BY v.last_seen DESC LIMIT 300`).all(q, `%${q}%`, `%${q}%`);
      return { contacts: rows.map(v => ({ ...visitorOut(v), site_name: siteRow(v.site_id)?.name, notes: v.notes, conversations: v.convs })) };
    } },
    { method: 'GET', path: '/api/export/contacts.csv', auth: 'ws', perm: 'contacts.export', handler: c => {
      const rows = db.prepare(`SELECT * FROM visitors WHERE site_id IN ${c.inSites(c.scopeSites())} AND email IS NOT NULL ORDER BY created DESC`).all();
      c.log('contacts.exported', `${rows.length} contacts`);
      c.res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="contacts.csv"' });
      c.res.end('name,email,website,visits,first_seen,last_page\n' + rows.map(v => [v.name, v.email, siteRow(v.site_id)?.name, v.visits, new Date(v.created).toISOString(), v.page].map(csv).join(',')).join('\n'));
    } },
    { method: 'GET', path: '/api/contacts/:id', auth: 'ws', perm: 'contacts.view', handler: c => {
      const v = loadContact(c);
      let convs = db.prepare('SELECT * FROM conversations WHERE visitor_id=? ORDER BY id DESC').all(v.id);
      if (!c.can('chats.view_all')) convs = convs.filter(x => !x.assignee_id || x.assignee_id === c.me.id);
      return { contact: { ...visitorOut(v), site_name: siteRow(v.site_id)?.name, notes: v.notes }, conversations: convs.map(convOut) };
    } },
    { method: 'PUT', path: '/api/contacts/:id', auth: 'ws', perm: 'contacts.edit', handler: async c => {
      const v = loadContact(c), b = await c.body(), email = str(b.email, 200).toLowerCase();
      if (email && !EMAIL.test(email)) fail(400, 'Invalid email');
      db.prepare('UPDATE visitors SET name=?, email=?, notes=? WHERE id=?').run(str(b.name, 100) || null, email || null, str(b.notes, 2000) || null, v.id);
      emitPresence(getVisitor(v.id), isOnline(v.id));
      return {};
    } },
  ],
});
