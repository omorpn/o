/** Spam protection for each business: block/report visitors, IP and keyword blocks, recent spam activity. */
import { db, now } from '../../core/db.js';
import { fail, str } from '../../core/http.js';
import { defineModule } from '../../core/modules.js';
import { kickVisitor } from '../../core/realtime.js';
import * as fraud from '../fraud/engine.js';
import { getConv, emitConv, siteRow, getVisitor } from '../livechat/service.js';
import { loadConv } from '../livechat/index.js';

export default defineModule({
  key: 'spam', name: 'Spam protection', description: 'Block and report visitors, block IPs and words, tune the spam filter.',
  routes: [
    { method: 'POST', path: '/api/conversations/:id/block', auth: 'ws', perm: 'chats.block', handler: async c => {
      const conv = loadConv(c, c.int('id')), b = await c.body(), v = getVisitor(conv.visitor_id);
      fraud.addBlock({ workspaceId: c.ws, type: 'visitor', value: v.id, reason: str(b.reason, 200) || (b.report ? 'Reported as spam' : 'Blocked by agent'), by: c.me.name });
      if (b.ip && v.ip) fraud.addBlock({ workspaceId: c.ws, type: 'ip', value: v.ip, reason: `Blocked with visitor ${v.name || v.id}`, by: c.me.name });
      if (b.report) {
        const tags = [...new Set([...(conv.tags ? JSON.parse(conv.tags) : []), 'spam'])];
        db.prepare("UPDATE conversations SET spam=1, status='closed', needs_human=0, tags=? WHERE id=?").run(JSON.stringify(tags), conv.id);
        const last = db.prepare("SELECT body FROM messages WHERE conv_id=? AND sender='visitor' ORDER BY id DESC LIMIT 1").get(conv.id)?.body || '';
        db.prepare('INSERT INTO fraud_events(created,kind,score,action,workspace_id,site_id,visitor_id,ip,summary,signals,status,reviewed_by,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(now(), 'visitor_message', 100, 'reported', c.ws, conv.site_id, v.id, v.ip, last.slice(0, 500), JSON.stringify([{ code: 'reported_by_agent', weight: 100, detail: `Reported by ${c.me.name}` }]), 'confirmed', c.me.name, now());
      }
      kickVisitor(v.id);
      c.log(b.report ? 'visitor.reported' : 'visitor.blocked', `${v.name || v.email || v.id}${b.ip ? ' + IP' : ''}`);
      emitConv(getConv(conv.id)); return {};
    } },
    { method: 'GET', path: '/api/spam', auth: 'ws', perm: 'chats.block', handler: c => {
      const blocks = db.prepare('SELECT id, type, value, reason, created_by, created, expires FROM blocklist WHERE workspace_id=? AND (expires IS NULL OR expires>?) ORDER BY id DESC LIMIT 500').all(c.ws, now());
      const events = db.prepare(`SELECT id, created, score, action, site_id, visitor_id, summary, signals FROM fraud_events WHERE workspace_id=? AND kind='visitor_message' AND site_id IN ${c.inSites(c.auth.siteIds)} ORDER BY id DESC LIMIT 100`).all(c.ws)
        .map(e => ({ ...e, signals: JSON.parse(e.signals), site_name: siteRow(e.site_id)?.name }));
      const counts = db.prepare("SELECT action, COUNT(*) n FROM fraud_events WHERE workspace_id=? AND kind='visitor_message' AND created>? GROUP BY action").all(c.ws, now() - 86400_000);
      return { blocks, events, last24h: Object.fromEntries(counts.map(r => [r.action, r.n])) };
    } },
    { method: 'POST', path: '/api/spam/blocks', auth: 'ws', perm: 'chats.block', handler: async c => {
      const b = await c.body();
      const type = ['ip', 'visitor', 'keyword', 'email'].includes(b.type) ? b.type : fail(400, 'Type must be ip, visitor, keyword or email');
      const value = str(b.value, 200).toLowerCase(); if (!value) fail(400, 'Value is required');
      if (type === 'keyword' && value.length < 3) fail(400, 'Blocked words need at least 3 characters');
      fraud.addBlock({ workspaceId: c.ws, type, value, reason: str(b.reason, 200) || 'Added manually', by: c.me.name, ttlMs: b.hours ? Math.min(8760, +b.hours) * 3600_000 : null });
      c.log('block.added', `${type}: ${value}`); return {};
    } },
    { method: 'DELETE', path: '/api/spam/blocks/:id', auth: 'ws', perm: 'chats.block', handler: c => {
      const r = db.prepare('SELECT * FROM blocklist WHERE id=? AND workspace_id=?').get(c.int('id'), c.ws); if (!r) fail(404, 'Not found');
      db.prepare('DELETE FROM blocklist WHERE id=?').run(r.id); c.log('block.removed', `${r.type}: ${r.value}`); return {};
    } },
  ],
});
