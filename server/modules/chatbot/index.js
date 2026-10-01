import { db } from '../../core/db.js';
import { fail, str } from '../../core/http.js';
import { defineModule } from '../../core/modules.js';
import { registerBotStep } from '../livechat/automation.js';
import { handoff, getConv } from '../livechat/service.js';
import { matchRule, matchKb, parseRule } from './engine.js';
import { matchFlow } from '../flows/engine.js';

function ruleFields(b) {
  const name = str(b.name, 80), keywords = str(b.keywords, 500), reply = str(b.reply, 2000);
  if (!name || !keywords || !reply) fail(400, 'Name, keywords and reply are required');
  const buttons = (Array.isArray(b.buttons) ? b.buttons : []).map(x => str(x, 40)).filter(Boolean).slice(0, 5);
  return { name, keywords, reply, buttons: JSON.stringify(buttons), handoff: b.handoff ? 1 : 0, enabled: b.enabled === false ? 0 : 1 };
}

export default defineModule({
  key: 'chatbot', name: 'Chatbot', description: 'Keyword rules with quick replies and a knowledge base of answers.',
  init() {
    registerBotStep({ module: 'chatbot', order: 20, run(conv, text, { reply }) {
      const rule = matchRule(conv.site_id, text);
      if (rule) { reply(rule.reply, rule.buttons); if (rule.handoff) handoff(getConv(conv.id)); return true; }
      const kb = matchKb(conv.site_id, text);
      if (kb) { reply(kb.answer); return true; }
      return false;
    } });
  },
  routes: [
    { method: 'GET', path: '/api/rules', auth: 'ws', handler: c => ({ rules: db.prepare('SELECT * FROM rules WHERE site_id=? ORDER BY position, id').all(c.siteParam()).map(parseRule) }) },
    { method: 'POST', path: '/api/rules', auth: 'ws', perm: 'bot.manage', handler: async c => {
      const sid = c.siteParam(), r = ruleFields(await c.body());
      const pos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 n FROM rules WHERE site_id=?').get(sid).n;
      return { id: db.prepare('INSERT INTO rules(site_id,name,keywords,reply,buttons,handoff,enabled,position) VALUES(?,?,?,?,?,?,?,?)').run(sid, r.name, r.keywords, r.reply, r.buttons, r.handoff, r.enabled, pos).lastInsertRowid };
    } },
    { method: 'PUT', path: '/api/rules/:id', auth: 'ws', perm: 'bot.manage', handler: async c => {
      const sid = c.siteParam(), r = ruleFields(await c.body());
      db.prepare('UPDATE rules SET name=?,keywords=?,reply=?,buttons=?,handoff=?,enabled=? WHERE id=? AND site_id=?').run(r.name, r.keywords, r.reply, r.buttons, r.handoff, r.enabled, c.int('id'), sid); return {};
    } },
    { method: 'DELETE', path: '/api/rules/:id', auth: 'ws', perm: 'bot.manage', handler: c => { db.prepare('DELETE FROM rules WHERE id=? AND site_id=?').run(c.int('id'), c.siteParam()); return {}; } },
    { method: 'GET', path: '/api/kb', auth: 'ws', handler: c => ({ kb: db.prepare('SELECT id, question, answer FROM kb WHERE site_id=? ORDER BY id').all(c.siteParam()) }) },
    { method: 'POST', path: '/api/kb', auth: 'ws', perm: 'bot.manage', handler: async c => {
      const sid = c.siteParam(), b = await c.body(), q = str(b.question, 300), a = str(b.answer, 3000);
      if (!q || !a) fail(400, 'Question and answer required');
      db.prepare('INSERT INTO kb(site_id,question,answer) VALUES(?,?,?)').run(sid, q, a); return {};
    } },
    { method: 'DELETE', path: '/api/kb/:id', auth: 'ws', perm: 'bot.manage', handler: c => { db.prepare('DELETE FROM kb WHERE id=? AND site_id=?').run(c.int('id'), c.siteParam()); return {}; } },
    { method: 'POST', path: '/api/bot/test', auth: 'ws', handler: async c => {
      const sid = c.siteParam(), text = str((await c.body()).text, 500);
      const flow = c.moduleOn('flows') && matchFlow(sid, text), rule = !flow && matchRule(sid, text), kb = !flow && !rule && matchKb(sid, text);
      return { flow: flow ? { name: flow.name } : null, rule: rule || null, kb: kb || null };
    } },
  ],
});
