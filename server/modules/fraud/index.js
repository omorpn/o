/** Fraud & abuse (platform core): review queue, platform blocklist, account unlock, detection settings. */
import { db, now, setPlatform } from '../../core/db.js';
import { fail, str, EMAIL } from '../../core/http.js';
import { defineModule } from '../../core/modules.js';
import { platformAudit } from '../../core/auth.js';
import { kickUser, kickVisitor } from '../../core/realtime.js';
import * as fraud from './engine.js';
import { workspaceOut } from '../platform/index.js';

const n = (q, ...a) => db.prepare(q).get(...a).n;
const eventOut = e => ({ ...e, signals: JSON.parse(e.signals), workspace_name: e.workspace_id ? db.prepare('SELECT name FROM workspaces WHERE id=?').get(e.workspace_id)?.name : null,
  user_email: e.user_id ? db.prepare('SELECT email FROM users WHERE id=?').get(e.user_id)?.email : e.email });
const log = (c, a, d) => platformAudit(c.me, a, d);

export default defineModule({
  key: 'fraud', name: 'Fraud & abuse', description: 'Platform-wide risk scoring, review queue and blocklists.', core: true, hidden: true,
  routes: [
    { method: 'GET', path: '/api/platform/fraud/overview', auth: 'platform', handler: () => {
      const day = now() - 86400_000;
      return { byKind: db.prepare('SELECT kind, action, COUNT(*) n FROM fraud_events WHERE created>? GROUP BY kind, action').all(day),
        open: n("SELECT COUNT(*) n FROM fraud_events WHERE status='open'"), blocked24h: n("SELECT COUNT(*) n FROM fraud_events WHERE created>? AND action='blocked'", day),
        lockedAccounts: n('SELECT COUNT(*) n FROM users WHERE locked_until>?', now()), blocklist: n('SELECT COUNT(*) n FROM blocklist WHERE workspace_id IS NULL AND (expires IS NULL OR expires>?)', now()),
        risky: db.prepare('SELECT * FROM workspaces WHERE risk_score>0 ORDER BY risk_score DESC LIMIT 10').all().map(w => ({ ...workspaceOut(w), risk_score: w.risk_score })), settings: fraud.fraudSettings() };
    } },
    { method: 'GET', path: '/api/platform/fraud/events', auth: 'platform', handler: c => {
      const st = c.query.get('status') || 'open', kind = c.query.get('kind');
      let sql = 'SELECT * FROM fraud_events WHERE 1=1'; const args = [];
      if (st !== 'all') { sql += ' AND status=?'; args.push(st); }
      if (kind) { sql += ' AND kind=?'; args.push(kind); }
      return { events: db.prepare(sql + ' ORDER BY score DESC, id DESC LIMIT 200').all(...args).map(eventOut) };
    } },
    { method: 'POST', path: '/api/platform/fraud/events/:id', auth: 'platform', handler: async c => {
      const e = db.prepare('SELECT * FROM fraud_events WHERE id=?').get(c.int('id')); if (!e) fail(404, 'Event not found');
      const b = await c.body(), a = b.actions || {}, done = [], me = c.me;
      if (!['confirm', 'dismiss'].includes(b.decision)) fail(400, 'Decision must be confirm or dismiss');
      db.prepare('UPDATE fraud_events SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?').run(b.decision === 'confirm' ? 'confirmed' : 'dismissed', me.name, now(), e.id);
      if (b.decision === 'confirm') {
        const reason = `Fraud review #${e.id}: ${e.summary?.slice(0, 80) || e.kind}`;
        if (a.block_ip && e.ip) { fraud.addBlock({ type: 'ip', value: e.ip, reason, by: me.name, ttlMs: a.ttl_hours ? a.ttl_hours * 3600_000 : null }); done.push('blocked IP ' + e.ip); }
        const email = e.email || (e.user_id && db.prepare('SELECT email FROM users WHERE id=?').get(e.user_id)?.email);
        if (a.block_email && email) { fraud.addBlock({ type: 'email', value: email, reason, by: me.name }); done.push('blocked email ' + email); }
        if (a.block_domain && email) { fraud.addBlock({ type: 'email_domain', value: email.split('@')[1], reason, by: me.name }); done.push('blocked domain ' + email.split('@')[1]); }
        if (a.block_visitor && e.visitor_id) { fraud.addBlock({ type: 'visitor', value: e.visitor_id, reason, by: me.name }); kickVisitor(e.visitor_id); done.push('blocked visitor'); }
        if (a.disable_user && e.user_id && e.user_id !== me.id) { db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(e.user_id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(e.user_id); kickUser(e.user_id); done.push('disabled user'); }
        if (a.suspend_workspace && e.workspace_id) { fraud.suspendWorkspace(e.workspace_id, 'Suspended after fraud review', me); done.push('suspended workspace'); }
      }
      if (e.workspace_id) fraud.bumpWorkspaceRisk(e.workspace_id);
      log(c, `fraud.${b.decision}`, `#${e.id} ${e.kind} score ${e.score}${done.length ? ' → ' + done.join(', ') : ''}`);
      return { done };
    } },
    { method: 'GET', path: '/api/platform/fraud/blocklist', auth: 'platform', handler: () => ({ blocks: db.prepare('SELECT * FROM blocklist WHERE workspace_id IS NULL AND (expires IS NULL OR expires>?) ORDER BY id DESC LIMIT 1000').all(now()) }) },
    { method: 'POST', path: '/api/platform/fraud/blocklist', auth: 'platform', handler: async c => {
      const b = await c.body();
      const type = ['ip', 'email', 'email_domain', 'keyword', 'visitor'].includes(b.type) ? b.type : fail(400, 'Unknown block type');
      const value = str(b.value, 200).toLowerCase(); if (!value) fail(400, 'Value is required');
      if (type === 'email' && !EMAIL.test(value)) fail(400, 'Not a valid email');
      if (type === 'email_domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) fail(400, 'Not a valid domain');
      fraud.addBlock({ type, value, reason: str(b.reason, 200) || 'Added by platform admin', by: c.me.name, ttlMs: b.hours ? Math.min(8760, +b.hours) * 3600_000 : null });
      log(c, 'fraud.block_added', `${type}: ${value}`); return {};
    } },
    { method: 'DELETE', path: '/api/platform/fraud/blocklist/:id', auth: 'platform', handler: c => {
      const r = db.prepare('SELECT * FROM blocklist WHERE id=? AND workspace_id IS NULL').get(c.int('id')); if (!r) fail(404, 'Not found');
      db.prepare('DELETE FROM blocklist WHERE id=?').run(r.id); log(c, 'fraud.block_removed', `${r.type}: ${r.value}`); return {};
    } },
    { method: 'POST', path: '/api/platform/fraud/unlock', auth: 'platform', handler: async c => {
      const email = str((await c.body()).email, 200).toLowerCase();
      db.prepare('UPDATE users SET locked_until=NULL WHERE email=?').run(email); db.prepare('DELETE FROM login_failures WHERE email=?').run(email);
      log(c, 'fraud.unlocked', email); return {};
    } },
    { method: 'PUT', path: '/api/platform/fraud/settings', auth: 'platform', handler: async c => {
      const b = await c.body(), patch = {};
      if ('fraudMode' in b) patch.fraudMode = b.fraudMode === 'monitor' ? 'monitor' : 'enforce';
      for (const k of ['reviewThreshold', 'blockThreshold', 'autoSuspendThreshold']) if (k in b) { const v = Math.round(Number(b[k])); if (!(v >= 1 && v <= 1000)) fail(400, `${k} must be between 1 and 1000`); patch[k] = v; }
      if ('autoSuspend' in b) patch.autoSuspend = !!b.autoSuspend;
      const merged = { ...fraud.fraudSettings(), ...patch };
      if (merged.reviewThreshold >= merged.blockThreshold) fail(400, 'Review threshold must be lower than the block threshold');
      setPlatform(patch); log(c, 'fraud.settings', Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', '));
      return { settings: fraud.fraudSettings() };
    } },
    { method: 'POST', path: '/api/platform/fraud/rescan', auth: 'platform', handler: () => {
      const rows = db.prepare('SELECT id FROM workspaces').all(); for (const r of rows) fraud.bumpWorkspaceRisk(r.id);
      return { scanned: rows.length };
    } },
  ],
});
