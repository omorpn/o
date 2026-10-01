import { db } from '../../core/db.js';
import { keywordScore } from '../../core/text.js';

export function matchFlow(siteId, text) {
  let best = null, bestScore = 0;
  for (const f of db.prepare('SELECT * FROM flows WHERE site_id=? AND enabled=1 ORDER BY id').all(siteId)) {
    const sc = keywordScore(text, f.keywords); if (sc > bestScore) { best = f; bestScore = sc; }
  }
  return best ? { ...best, nodes: JSON.parse(best.nodes) } : null;
}

export const NODE_TYPES = ['message', 'choice', 'ask', 'handoff', 'end'];
export const ASK_FIELDS = ['name', 'email', 'phone', 'text'];
/** Validates a flow's node list; returns an error string or null. */
export function validateNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 50) return 'A flow needs 1–50 steps';
  const ids = new Set();
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || !/^[\w-]{1,30}$/.test(n.id)) return 'Step ids must be letters, digits, - or _';
    if (ids.has(n.id)) return `Duplicate step id "${n.id}"`; ids.add(n.id);
    if (!NODE_TYPES.includes(n.type)) return `Unknown step type "${n.type}"`;
    if (n.type !== 'end' && !(typeof n.text === 'string' && n.text.trim())) return `Step "${n.id}" needs text`;
    if (n.type === 'ask' && !ASK_FIELDS.includes(n.field)) return `Step "${n.id}" has a bad field`;
    if (n.type === 'handoff' && n.department != null && !(Number.isInteger(n.department) && n.department > 0)) return `Step "${n.id}" has a bad department`;
    if (n.type === 'choice' && !(Array.isArray(n.options) && n.options.length && n.options.length <= 6 && n.options.every(o => o && typeof o.label === 'string' && o.label.trim()))) return `Step "${n.id}" needs 1–6 options with labels`;
  }
  for (const n of nodes) for (const nx of [n.next, ...(n.options || []).map(o => o.next)]) if (nx && !ids.has(nx)) return `Step "${n.id}" points to missing step "${nx}"`;
  return null;
}


// ---------- runtime ----------
import { EMAIL } from '../../core/http.js';
import { emit } from '../../core/events.js';
import { getConv, addMessage, handoff, setFlowState, identifyVisitor } from '../livechat/service.js';

/** Plays flow steps from `nodeId` until the flow needs an answer, hands off or ends. */
export function runFlow(convId, flow, nodeId) {
  for (let steps = 0; nodeId && steps < 25; steps++) {
    const n = flow.nodes.find(x => x.id === nodeId); if (!n || n.type === 'end') break;
    addMessage(getConv(convId), 'bot', n.text, { senderName: 'Bot', buttons: n.type === 'choice' ? n.options.map(o => o.label) : null });
    if (n.type === 'choice' || n.type === 'ask') return setFlowState(convId, { flow: flow.id, node: n.id });
    if (n.type === 'handoff') { setFlowState(convId, null); return handoff(getConv(convId), { departmentId: n.department }); }
    nodeId = n.next;
  }
  setFlowState(convId, null);
}

/** Consumes the visitor's answer if a flow is waiting on one. Returns true when handled. */
export function flowAnswer(conv, text) {
  const st = conv.flow_state ? JSON.parse(conv.flow_state) : null; if (!st) return false;
  const f = db.prepare('SELECT * FROM flows WHERE id=? AND site_id=?').get(st.flow, conv.site_id);
  const flow = f && { ...f, nodes: JSON.parse(f.nodes) }, n = flow?.nodes.find(x => x.id === st.node);
  if (!n) { setFlowState(conv.id, null); return false; }
  if (n.type === 'choice') {
    const o = n.options.find(x => x.label.toLowerCase() === text.toLowerCase());
    if (!o) { setFlowState(conv.id, null); return false; }
    runFlow(conv.id, flow, o.next); return true;
  }
  if (n.type === 'ask') {
    if (n.field === 'email') {
      const email = text.toLowerCase();
      if (!EMAIL.test(email)) { addMessage(getConv(conv.id), 'bot', "That doesn't look like a valid email — could you try again?", { senderName: 'Bot' }); return true; }
      identifyVisitor(conv.visitor_id, { email });
      addMessage(getConv(conv.id), 'system', `Visitor shared their email: ${email}`);
    } else if (n.field === 'name') identifyVisitor(conv.visitor_id, { name: text.slice(0, 100) });
    else addMessage(getConv(conv.id), 'system', `${n.field === 'phone' ? 'Phone' : 'Answer'}: ${text}`);
    emit('flow.answer', { conv: getConv(conv.id), field: n.field, value: text });
    runFlow(conv.id, flow, n.next); return true;
  }
  setFlowState(conv.id, null); return false;
}
