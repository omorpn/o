/**
 * Module registry. Every feature registers itself here with its routes, permissions and event handlers.
 * Non-core modules can be switched on/off per workspace and limited per plan by the platform operator.
 */
import { db, getPlatform } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS workspace_modules (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, module TEXT NOT NULL, enabled INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, module));`);

const registry = new Map();

/**
 * @param {object} def
 * @param {string} def.key           unique id, e.g. "flows"
 * @param {string} def.name          label shown in the dashboard
 * @param {string} def.description
 * @param {boolean} [def.core]       always on, cannot be disabled
 * @param {boolean} [def.defaultOn]  initial state for workspaces (default true)
 * @param {Array}  [def.routes]      route definitions (see core/router.js)
 * @param {Function} [def.init]      called once at startup (subscribe to events, timers, …)
 */
export function defineModule(def) {
  if (registry.has(def.key)) throw new Error(`Module ${def.key} registered twice`);
  const mod = { core: false, defaultOn: true, routes: [], ...def };
  for (const r of mod.routes) r.module = mod.key;
  registry.set(def.key, mod);
  return mod;
}

export const allModules = () => [...registry.values()];
export const getModule = key => registry.get(key);

/** Modules a plan includes. Missing plan entry means "everything". */
export function planAllows(plan, key) {
  const m = registry.get(key); if (!m || m.core) return true;
  const map = getPlatform().planModules || {};
  return !Array.isArray(map[plan]) || map[plan].includes(key);
}

export function isEnabled(workspaceId, key) {
  const m = registry.get(key); if (!m) return false;
  if (m.core) return true;
  if (!workspaceId) return m.defaultOn;
  const ws = db.prepare('SELECT plan FROM workspaces WHERE id=?').get(workspaceId);
  if (!ws || !planAllows(ws.plan, key)) return false;
  const row = db.prepare('SELECT enabled FROM workspace_modules WHERE workspace_id=? AND module=?').get(workspaceId, key);
  return row ? !!row.enabled : m.defaultOn;
}

export function setEnabled(workspaceId, key, enabled) {
  db.prepare('INSERT INTO workspace_modules(workspace_id,module,enabled) VALUES(?,?,?) ON CONFLICT(workspace_id,module) DO UPDATE SET enabled=excluded.enabled')
    .run(workspaceId, key, enabled ? 1 : 0);
}

export function modulesFor(workspaceId) {
  const plan = workspaceId ? db.prepare('SELECT plan FROM workspaces WHERE id=?').get(workspaceId)?.plan : null;
  return allModules().filter(m => !m.hidden).map(m => ({ key: m.key, name: m.name, description: m.description, core: !!m.core,
    available: plan ? planAllows(plan, m.key) : true, enabled: isEnabled(workspaceId, m.key) }));
}
