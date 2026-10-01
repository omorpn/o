import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_ROLES } from './rbac.js';

const file = process.env.DB_FILE || path.join(process.cwd(), 'data', 'chatly.db');
if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
// SQLITE_JOURNAL=delete is required on network filesystems (NFS / GCS FUSE) where WAL is unsafe
db.exec(`PRAGMA journal_mode = ${process.env.SQLITE_JOURNAL === 'delete' ? 'DELETE' : 'WAL'}; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);

if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'").get() && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get()) {
  throw new Error(`${file} was created by the single-workspace version of Chatly. Move it aside (or set DB_FILE) to start with the multi-workspace schema.`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, pass TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, permissions TEXT NOT NULL, system INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS members (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id), site_ids TEXT, created INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_id));
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, domain TEXT, site_key TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, last_seen_at INTEGER, last_origin TEXT, last_error TEXT, last_error_at INTEGER);
CREATE TABLE IF NOT EXISTS site_settings (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (site_id, key));
CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT, email TEXT, notes TEXT, created INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  page TEXT, ua TEXT, visits INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_visitors_site ON visitors(site_id, last_seen);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open', assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  bot_active INTEGER NOT NULL DEFAULT 1, needs_human INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
  last_body TEXT, tags TEXT, flow_state TEXT, rating INTEGER, rating_comment TEXT, first_reply INTEGER, last_notified INTEGER,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_conv_ws ON conversations(workspace_id, status, updated);
CREATE INDEX IF NOT EXISTS idx_conv_visitor ON conversations(visitor_id, status);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, conv_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender TEXT NOT NULL, sender_id INTEGER, sender_name TEXT, body TEXT NOT NULL, buttons TEXT, attachment TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, name TEXT NOT NULL, keywords TEXT NOT NULL,
  reply TEXT NOT NULL, buttons TEXT NOT NULL DEFAULT '[]', handoff INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS kb (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, question TEXT NOT NULL, answer TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flows (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, name TEXT NOT NULL, keywords TEXT NOT NULL, nodes TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS triggers (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, name TEXT NOT NULL, url_contains TEXT NOT NULL DEFAULT '', delay INTEGER NOT NULL DEFAULT 10, message TEXT NOT NULL, open_chat INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS canned (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, shortcut TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(workspace_id, shortcut));
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id INTEGER, user_name TEXT, action TEXT NOT NULL, detail TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit(workspace_id, id);
CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS platform_audit (id INTEGER PRIMARY KEY, user_id INTEGER, user_name TEXT, action TEXT NOT NULL, detail TEXT, created INTEGER NOT NULL);
`);

for (const [t, col] of [['sites', 'last_seen_at INTEGER'], ['sites', 'last_origin TEXT'], ['sites', 'last_error TEXT'], ['sites', 'last_error_at INTEGER'],
  ['users', 'platform_role TEXT'], ['users', 'disabled INTEGER NOT NULL DEFAULT 0'], ['users', 'last_login INTEGER'],
  ['workspaces', "plan TEXT NOT NULL DEFAULT 'free'"], ['workspaces', 'suspended INTEGER NOT NULL DEFAULT 0'], ['workspaces', 'suspended_reason TEXT']]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`); } catch { /* already exists */ }
}

// Inbox organisation: departments (teams), routing state, saved views, per-user preferences, workspace settings
db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT,
  color TEXT NOT NULL DEFAULT '#6366f1', public INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS department_members (
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (department_id, user_id));
CREATE TABLE IF NOT EXISTS inbox_views (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, filters TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS user_prefs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
CREATE TABLE IF NOT EXISTS workspace_settings (workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (workspace_id, key));
`);
for (const col of ['department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL', "priority TEXT NOT NULL DEFAULT 'normal'", 'snoozed_until INTEGER', "channel TEXT NOT NULL DEFAULT 'web'", 'last_inbound INTEGER', 'channel_id INTEGER']) {
  try { db.exec(`ALTER TABLE conversations ADD COLUMN ${col}`); } catch { /* exists */ }
}
try { db.exec('ALTER TABLE members ADD COLUMN last_routed INTEGER'); } catch { /* exists */ }
for (const col of ['phone TEXT', "channel TEXT NOT NULL DEFAULT 'web'"]) { try { db.exec(`ALTER TABLE visitors ADD COLUMN ${col}`); } catch { /* exists */ } }
for (const col of ['external_id TEXT', 'delivery TEXT']) { try { db.exec(`ALTER TABLE messages ADD COLUMN ${col}`); } catch { /* exists */ } }
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_external ON messages(external_id) WHERE external_id IS NOT NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_conv_snooze ON conversations(snoozed_until) WHERE snoozed_until IS NOT NULL');

export const WS_DEFAULTS = { assignmentMode: 'manual', maxChats: 0, widgetDepartments: false };
db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL)');
/** Runs a data migration exactly once per database. */
export function once(name, fn) {
  if (db.prepare('SELECT 1 FROM migrations WHERE name=?').get(name)) return;
  fn(); db.prepare('INSERT INTO migrations(name,at) VALUES(?,?)').run(name, Date.now());
}
/** Lets a feature module add its own workspace-level settings (with defaults). */
export const registerWsDefaults = defaults => Object.assign(WS_DEFAULTS, defaults);
export function getWsSettings(ws) {
  const out = { ...WS_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM workspace_settings WHERE workspace_id=?').all(ws)) out[r.key] = JSON.parse(r.value);
  return out;
}
export function setWsSettings(ws, patch) {
  const st = db.prepare('INSERT INTO workspace_settings(workspace_id,key,value) VALUES(?,?,?) ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(patch)) if (k in WS_DEFAULTS) st.run(ws, k, JSON.stringify(v));
}

for (const col of ['ip TEXT', 'ua TEXT', 'last_seen INTEGER']) { try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* exists */ } }

export const now = () => Date.now();

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 32).toString('hex');
}
export function checkPassword(pw, stored) {
  const [s, h] = stored.split(':');
  const a = scryptSync(pw, Buffer.from(s, 'hex'), 32);
  const b = Buffer.from(h, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const DEFAULT_SETTINGS = {
  brandName: 'Chatly', title: 'Chat with us', subtitle: 'We usually reply in a few minutes', color: '#4f46e5', position: 'right',
  greeting: 'Hi there 👋 How can we help you today?',
  offlineMessage: "We're away right now. Leave your email and we'll get back to you.",
  handoffMessage: 'Connecting you with a human teammate…',
  fallbackMessage: "I'm not sure I understood. Would you like to talk to a person?",
  askEmail: true, botEnabled: true, proactiveEnabled: true, proactiveDelay: 8, proactiveMessage: 'Need a hand? Ask us anything!',
  allowedOrigins: '*',
  aiEnabled: false, aiInstructions: 'You are a friendly support assistant for our company. Keep answers short.',
  ratingEnabled: true, businessHoursEnabled: false, hoursStart: '09:00', hoursEnd: '17:00', hoursDays: '1,2,3,4,5', timezone: 'UTC',
  webhookUrl: '', gradient: true, launcherStyle: 'circle', launcherLabel: 'Chat with us', avatarUrl: '', theme: 'light',
  prechatForm: false, showBranding: true, emailNotifications: true, emailReplies: true, emailTranscript: false, spamFilter: 'normal', slaMinutes: 5,
};

export function getSettings(siteId) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM site_settings WHERE site_id=?').all(siteId)) out[r.key] = JSON.parse(r.value);
  return out;
}
export function setSettings(siteId, patch) {
  const st = db.prepare('INSERT INTO site_settings(site_id,key,value) VALUES(?,?,?) ON CONFLICT(site_id,key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) st.run(siteId, k, JSON.stringify(v));
}

export const PLATFORM_DEFAULTS = { allowSignup: true, announcement: '', plans: 'free,starter,pro,enterprise', fraudMode: 'enforce', reviewThreshold: 40, blockThreshold: 70, autoSuspend: false, autoSuspendThreshold: 250, planModules: {}, planCatalog: {} };
export function getPlatform() {
  const out = { ...PLATFORM_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM platform_settings').all()) out[r.key] = JSON.parse(r.value);
  if (process.env.ALLOW_SIGNUP === '0') out.allowSignup = false;
  return out;
}
export function setPlatform(patch) {
  const st = db.prepare('INSERT INTO platform_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(patch)) if (k in PLATFORM_DEFAULTS) st.run(k, JSON.stringify(v));
}

export const newSiteKey = () => 'ck_' + randomBytes(12).toString('hex');

/** Creates a website inside a workspace and fills it with starter bot content. */
export function createSite(workspaceId, name, domain = null) {
  const siteId = Number(db.prepare('INSERT INTO sites(workspace_id,name,domain,site_key,created) VALUES(?,?,?,?,?)').run(workspaceId, name, domain, newSiteKey(), now()).lastInsertRowid);
  const rule = db.prepare('INSERT INTO rules(site_id,name,keywords,reply,buttons,handoff,position) VALUES(?,?,?,?,?,?,?)');
  rule.run(siteId, 'Greeting', 'hi, hello, hey, good morning', 'Hello! 👋 What can I help you with?', JSON.stringify(['Pricing', 'Shipping', 'Talk to a human']), 0, 0);
  rule.run(siteId, 'Pricing', 'price, pricing, cost, plan', 'Our plans start at $19/month. You can see full details on our pricing page.', '[]', 0, 1);
  rule.run(siteId, 'Shipping', 'shipping, delivery, track, order', 'Orders ship within 24h and arrive in 3–5 business days.', '[]', 0, 2);
  rule.run(siteId, 'Human handoff', 'human, agent, person, support, representative', 'Sure, let me bring in a teammate.', '[]', 1, 3);
  db.prepare('INSERT INTO kb(site_id,question,answer) VALUES(?,?,?)').run(siteId, 'What is your return policy?', 'You can return any item within 30 days for a full refund.');
  db.prepare('INSERT INTO kb(site_id,question,answer) VALUES(?,?,?)').run(siteId, 'What payment methods do you accept?', 'We accept all major credit cards, PayPal and Apple Pay.');
  db.prepare('INSERT INTO flows(site_id,name,keywords,nodes) VALUES(?,?,?,?)').run(siteId, 'Lead capture', 'demo, quote, lead, contact me', JSON.stringify([
    { id: 'n1', type: 'message', text: 'Happy to set you up! Let me grab a few details.', next: 'n2' },
    { id: 'n2', type: 'ask', text: "What's your name?", field: 'name', next: 'n3' },
    { id: 'n3', type: 'ask', text: 'And your email address?', field: 'email', next: 'n4' },
    { id: 'n4', type: 'choice', text: 'Thanks! What are you interested in?', options: [{ label: 'Pricing', next: 'n5' }, { label: 'Talk to sales', next: 'n6' }] },
    { id: 'n5', type: 'message', text: 'Our plans start at $19/month — full details on the pricing page.', next: 'n7' },
    { id: 'n6', type: 'handoff', text: 'Great, bringing in our sales team now.' },
    { id: 'n7', type: 'end', text: '' }]));
  db.prepare('INSERT INTO triggers(site_id,name,url_contains,delay,message,open_chat) VALUES(?,?,?,?,?,?)').run(siteId, 'Pricing page help', '/pricing', 15, 'Questions about our plans? I can help you pick the right one.', 0);
  return siteId;
}

/** Creates a workspace with default roles, the owner membership, a first site and saved replies. */
export function createWorkspace(name, ownerId, siteName = 'My website', domain = null) {
  const wsId = Number(db.prepare('INSERT INTO workspaces(name,created) VALUES(?,?)').run(name, now()).lastInsertRowid);
  let ownerRole;
  for (const r of DEFAULT_ROLES) {
    const id = Number(db.prepare('INSERT INTO roles(workspace_id,name,permissions,system) VALUES(?,?,?,?)').run(wsId, r.name, JSON.stringify(r.permissions), r.system).lastInsertRowid);
    if (r.name === 'Owner') ownerRole = id;
  }
  db.prepare('INSERT INTO members(user_id,workspace_id,role_id,created) VALUES(?,?,?,?)').run(ownerId, wsId, ownerRole, now());
  const canned = db.prepare('INSERT INTO canned(workspace_id,shortcut,text) VALUES(?,?,?)');
  canned.run(wsId, 'thanks', 'Thanks for reaching out! Is there anything else I can help with?');
  canned.run(wsId, 'hold', 'Thanks for your patience — give me a moment while I look into this.');
  canned.run(wsId, 'bye', 'Glad I could help. Have a wonderful day!');
  const siteId = createSite(wsId, siteName, domain);
  return { wsId, siteId };
}

export function seed() {
  // Platform operators: the first account plus anyone listed in PLATFORM_ADMINS (comma-separated emails)
  const promote = () => {
    for (const e of (process.env.PLATFORM_ADMINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)) db.prepare("UPDATE users SET platform_role='superadmin' WHERE email=?").run(e);
    if (!db.prepare("SELECT 1 FROM users WHERE platform_role='superadmin'").get()) db.prepare("UPDATE users SET platform_role='superadmin' WHERE id=(SELECT MIN(id) FROM users)").run();
  };
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return promote();
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? randomBytes(9).toString('base64url') : 'admin123');
  const uid = Number(db.prepare('INSERT INTO users(name,email,pass,created) VALUES(?,?,?,?)').run('Admin', email, hashPassword(pw), now()).lastInsertRowid);
  createWorkspace('My workspace', uid);
  promote();
  console.log(`Created platform admin + owner account: ${email} / ${pw}  (change it under Settings → My account)`);
}
