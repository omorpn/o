/**
 * Realtime hub (Server-Sent Events). Agent streams carry the viewer's scope so every event is filtered
 * by workspace, website access and permissions before it leaves the server.
 */
import { db } from './db.js';

export const agentStreams = new Set();     // { res, userId, ws, sites: Set|null, viewAll, canReply }
export const visitorStreams = new Map();   // visitor key "<siteId>:<vid>" -> Set(res)

export function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
}
export const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
/** Writes to a stream unless it was already ended (kicked connections linger until their 'close' event). */
export const put = (res, f) => { if (!res.writableEnded && !res.destroyed) res.write(f); };
const streamSees = (s, siteId, conv) => (s.sites === null || s.sites.has(siteId)) && (!conv || s.viewAll || !conv.assignee_id || conv.assignee_id === s.userId);

/** Sends to every agent of a workspace who may see `siteId` (and `conv`, when it is assigned). */
export function toAgents(ws, siteId, event, data, conv) {
  const f = frame(event, data);
  for (const s of agentStreams) if (s.ws === ws && (siteId == null || streamSees(s, siteId, conv))) put(s.res, f);
}
/** Sends to one user's open dashboards (any workspace). */
export function toUser(userId, event, data) {
  const f = frame(event, data);
  for (const s of agentStreams) if (s.userId === userId) put(s.res, f);
}
export const toVisitor = (vkey, event, data) => { const f = frame(event, data); for (const r of visitorStreams.get(vkey) || []) put(r, f); };
export function toSiteVisitors(siteId, event, data) {
  const f = frame(event, data), prefix = siteId + ':';
  for (const [k, set] of visitorStreams) if (k.startsWith(prefix)) for (const r of set) put(r, f);
}
setInterval(() => {
  for (const s of agentStreams) put(s.res, ': ping\n\n');
  for (const set of visitorStreams.values()) for (const r of set) put(r, ': ping\n\n');
}, 25_000).unref();

const siteWs = id => db.prepare('SELECT workspace_id FROM sites WHERE id=?').get(id)?.workspace_id;

/** Agents who set themselves "Away" stay connected (and notified) but don't count as available and get no routed chats. */
export const awayUsers = new Set(db.prepare("SELECT user_id FROM user_prefs WHERE key='agentStatus' AND value='\"away\"'").all().map(r => r.user_id));
export function setAway(userId, away) {
  if (away) awayUsers.add(userId); else awayUsers.delete(userId);
  db.prepare('INSERT INTO user_prefs(user_id,key,value) VALUES(?,\'agentStatus\',?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value').run(userId, JSON.stringify(away ? 'away' : 'available'));
}
export const agentStatus = userId => (awayUsers.has(userId) ? 'away' : 'available');
/** Users connected to the dashboard who can reply on this website and are not away. */
export function availableAgents(ws, siteId) {
  return new Set([...agentStreams].filter(s => s.canReply && s.ws === ws && !awayUsers.has(s.userId) && (s.sites === null || s.sites.has(siteId))).map(s => s.userId));
}
export const agentsOnline = siteId => availableAgents(siteWs(siteId), siteId).size;
export const userOnline = userId => [...agentStreams].some(s => s.userId === userId);
export const isOnline = vkey => (visitorStreams.get(vkey)?.size || 0) > 0;

/** Ends a user's live connections (optionally only in one workspace) so they reconnect with fresh permissions. */
export function kickUser(userId, ws) { for (const s of agentStreams) if (s.userId === userId && (ws == null || s.ws === ws)) { agentStreams.delete(s); s.res.end(); } }
export function kickWorkspace(ws) {
  for (const s of agentStreams) if (s.ws === ws) { agentStreams.delete(s); s.res.end(); }
  const ids = new Set(db.prepare('SELECT id FROM sites WHERE workspace_id=?').all(ws).map(r => String(r.id)));
  for (const [k, set] of visitorStreams) if (ids.has(k.split(':')[0])) { visitorStreams.delete(k); for (const r of set) r.end(); }
}
export function kickVisitor(vkey) { const set = visitorStreams.get(vkey); visitorStreams.delete(vkey); for (const r of set || []) r.end(); }
