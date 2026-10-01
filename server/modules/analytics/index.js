/** Reports: 14-day volume, first response time, satisfaction, bot share, per-agent performance. */
import { db } from '../../core/db.js';
import { defineModule } from '../../core/modules.js';

export default defineModule({
  key: 'analytics', name: 'Analytics', description: 'Reports on volume, response times, satisfaction and team performance.',
  routes: [
    { method: 'GET', path: '/api/analytics', auth: 'ws', perm: 'analytics.view', handler: c => {
      const S = c.inSites(c.scopeSites());
      const days = []; const d0 = new Date(); d0.setHours(0, 0, 0, 0);
      for (let i = 13; i >= 0; i--) {
        const a = d0.getTime() - i * 86400000;
        days.push({ date: new Date(a).toISOString().slice(0, 10),
          chats: db.prepare(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND created>=? AND created<?`).get(a, a + 86400000).n,
          messages: db.prepare(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conv_id WHERE c.site_id IN ${S} AND m.created>=? AND m.created<? AND m.sender!='system'`).get(a, a + 86400000).n });
      }
      const total = db.prepare(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S}`).get().n;
      const botOnly = db.prepare(`SELECT COUNT(*) n FROM conversations WHERE site_id IN ${S} AND needs_human=0 AND first_reply IS NULL AND bot_active=1`).get().n;
      const fr = db.prepare(`SELECT AVG(first_reply) a FROM conversations WHERE site_id IN ${S} AND first_reply IS NOT NULL`).get().a;
      const cs = db.prepare(`SELECT AVG(rating) a, COUNT(rating) n FROM conversations WHERE site_id IN ${S} AND rating IS NOT NULL`).get();
      const agents = db.prepare(`SELECT u.name, COUNT(DISTINCT c.id) chats, AVG(c.rating) csat FROM conversations c JOIN users u ON u.id=c.assignee_id WHERE c.site_id IN ${S} GROUP BY u.id ORDER BY chats DESC LIMIT 20`).all()
        .map(a => ({ name: a.name, chats: a.chats, csat: a.csat ? Math.round(a.csat * 10) / 10 : null }));
      return { days, total, agents, botHandledPct: total ? Math.round(botOnly / total * 100) : 0, avgFirstResponseSec: fr ? Math.round(fr / 1000) : null,
        csat: cs.n ? Math.round(cs.a * 10) / 10 : null, ratings: cs.n, contacts: db.prepare(`SELECT COUNT(*) n FROM visitors WHERE site_id IN ${S} AND email IS NOT NULL`).get().n };
    } },
  ],
});
