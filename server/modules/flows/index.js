import { db } from '../../core/db.js';
import { fail, str } from '../../core/http.js';
import { defineModule } from '../../core/modules.js';
import { registerBotStep } from '../livechat/automation.js';
import { matchFlow, validateNodes, runFlow, flowAnswer } from './engine.js';

function flowFields(b, ws) {
  const name = str(b.name, 80), keywords = str(b.keywords, 500);
  if (!name || !keywords) fail(400, 'Name and trigger keywords are required');
  const nodes = (Array.isArray(b.nodes) ? b.nodes : []).map(n => ({ id: str(n?.id, 30), type: n?.type, text: str(n?.text, 1000),
    ...(n?.type === 'ask' ? { field: n.field } : {}), ...(n?.type === 'choice' ? { options: (Array.isArray(n.options) ? n.options : []).map(o => ({ label: str(o?.label, 40), next: str(o?.next, 30) })) } : {}),
    ...(['message', 'ask'].includes(n?.type) ? { next: str(n.next, 30) } : {}),
    ...(n?.type === 'handoff' && n.department != null && n.department !== '' ? { department: Number.isInteger(Number(n.department)) ? Number(n.department) : n.department } : {}) }));
  const err = validateNodes(nodes); if (err) fail(400, err);
  for (const n of nodes) if (n.department && !db.prepare('SELECT 1 FROM departments WHERE id=? AND workspace_id=?').get(n.department, ws)) fail(400, `Step "${n.id}" hands off to an unknown department`);
  return { name, keywords, nodes: JSON.stringify(nodes), enabled: b.enabled === false ? 0 : 1 };
}

export default defineModule({
  key: 'flows', name: 'Flows', description: 'Guided bot conversations: questions, choices, lead capture and handoff.',
  init() {
    registerBotStep({ module: 'flows', order: 10, run(conv, text) {
      if (flowAnswer(conv, text)) return true;
      const flow = matchFlow(conv.site_id, text);
      if (flow) { runFlow(conv.id, flow, flow.nodes[0].id); return true; }
      return false;
    } });
  },
  routes: [
    { method: 'GET', path: '/api/flows', auth: 'ws', handler: c => ({ flows: db.prepare('SELECT * FROM flows WHERE site_id=? ORDER BY id').all(c.siteParam()).map(f => ({ ...f, enabled: !!f.enabled, nodes: JSON.parse(f.nodes) })) }) },
    { method: 'POST', path: '/api/flows', auth: 'ws', perm: 'bot.manage', handler: async c => {
      const sid = c.siteParam(), f = flowFields(await c.body(), c.ws);
      return { id: db.prepare('INSERT INTO flows(site_id,name,keywords,nodes,enabled) VALUES(?,?,?,?,?)').run(sid, f.name, f.keywords, f.nodes, f.enabled).lastInsertRowid };
    } },
    { method: 'PUT', path: '/api/flows/:id', auth: 'ws', perm: 'bot.manage', handler: async c => {
      const sid = c.siteParam(), f = flowFields(await c.body(), c.ws);
      db.prepare('UPDATE flows SET name=?,keywords=?,nodes=?,enabled=? WHERE id=? AND site_id=?').run(f.name, f.keywords, f.nodes, f.enabled, c.int('id'), sid); return {};
    } },
    { method: 'DELETE', path: '/api/flows/:id', auth: 'ws', perm: 'bot.manage', handler: c => { db.prepare('DELETE FROM flows WHERE id=? AND site_id=?').run(c.int('id'), c.siteParam()); return {}; } },
  ],
});
