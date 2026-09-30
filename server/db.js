import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const file = process.env.DB_FILE || path.join(process.cwd(), 'data', 'chatly.db');
if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
// SQLITE_JOURNAL=delete is required on network filesystems (NFS / GCS FUSE) where WAL is unsafe
db.exec(`PRAGMA journal_mode = ${process.env.SQLITE_JOURNAL === 'delete' ? 'DELETE' : 'WAL'}; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'agent', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY, name TEXT, email TEXT, created INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  page TEXT, ua TEXT, country TEXT, visits INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open', assignee_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  bot_active INTEGER NOT NULL DEFAULT 1, needs_human INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0, last_body TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_conv_visitor ON conversations(visitor_id, status);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, conv_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender TEXT NOT NULL, sender_id INTEGER, sender_name TEXT, body TEXT NOT NULL,
  buttons TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, keywords TEXT NOT NULL, reply TEXT NOT NULL,
  buttons TEXT NOT NULL DEFAULT '[]', handoff INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS kb (id INTEGER PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flows (id INTEGER PRIMARY KEY, name TEXT NOT NULL, keywords TEXT NOT NULL, nodes TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS triggers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url_contains TEXT NOT NULL DEFAULT '', delay INTEGER NOT NULL DEFAULT 10, message TEXT NOT NULL, open_chat INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS canned (id INTEGER PRIMARY KEY, shortcut TEXT NOT NULL UNIQUE, text TEXT NOT NULL);
`);

for (const [t, col] of [['messages', 'attachment TEXT'], ['conversations', 'rating INTEGER'], ['conversations', 'rating_comment TEXT'], ['conversations', 'first_reply INTEGER'], ['conversations', 'flow_state TEXT'], ['conversations', 'last_notified INTEGER'], ['conversations', 'tags TEXT'], ['visitors', 'notes TEXT']]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`); } catch { /* already exists */ }
}

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
  siteKey: '',
  brandName: 'Chatly',
  title: 'Chat with us',
  subtitle: 'We usually reply in a few minutes',
  color: '#4f46e5',
  position: 'right',
  greeting: 'Hi there 👋 How can we help you today?',
  offlineMessage: "We're away right now. Leave your email and we'll get back to you.",
  handoffMessage: 'Connecting you with a human teammate…',
  fallbackMessage: "I'm not sure I understood. Would you like to talk to a person?",
  askEmail: true,
  botEnabled: true,
  proactiveEnabled: true,
  proactiveDelay: 8,
  proactiveMessage: 'Need a hand? Ask us anything!',
  allowedOrigins: '*',
  aiEnabled: false,
  aiInstructions: 'You are a friendly support assistant for our company. Keep answers short.',
  ratingEnabled: true,
  businessHoursEnabled: false,
  hoursStart: '09:00',
  hoursEnd: '17:00',
  hoursDays: '1,2,3,4,5',
  timezone: 'UTC',
  webhookUrl: '',
  gradient: true,
  launcherStyle: 'circle',
  launcherLabel: 'Chat with us',
  avatarUrl: '',
  theme: 'light',
  prechatForm: false,
  showBranding: true,
  emailNotifications: true,
  emailReplies: true,
  emailTranscript: false,
};

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = JSON.parse(r.value);
  return out;
}
export function setSettings(patch) {
  const st = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) st.run(k, JSON.stringify(v));
}

export function seed() {
  if (!getSettings().siteKey) setSettings({ siteKey: 'ck_' + randomBytes(9).toString('hex') });
  if (!db.prepare('SELECT 1 FROM agents LIMIT 1').get()) {
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const pw = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? randomBytes(9).toString('base64url') : 'admin123');
    db.prepare('INSERT INTO agents(name,email,pass,role,created) VALUES(?,?,?,?,?)')
      .run('Admin', email, hashPassword(pw), 'admin', now());
    console.log(`Created admin account: ${email} / ${pw}  (change it in Settings → Team)`);
  }
  if (!db.prepare('SELECT 1 FROM rules LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO rules(name,keywords,reply,buttons,handoff,position) VALUES(?,?,?,?,?,?)');
    ins.run('Greeting', 'hi, hello, hey, good morning', 'Hello! 👋 What can I help you with?', JSON.stringify(['Pricing', 'Shipping', 'Talk to a human']), 0, 0);
    ins.run('Pricing', 'price, pricing, cost, plan, plans', 'Our plans start at $19/month. You can see full details on our pricing page.', '[]', 0, 1);
    ins.run('Shipping', 'shipping, delivery, track, order', 'Orders ship within 24h and arrive in 3–5 business days.', '[]', 0, 2);
    ins.run('Human handoff', 'human, agent, person, support, representative', 'Sure, let me bring in a teammate.', '[]', 1, 3);
  }
  if (!db.prepare('SELECT 1 FROM kb LIMIT 1').get()) {
    db.prepare('INSERT INTO kb(question,answer) VALUES(?,?)').run('What is your return policy?', 'You can return any item within 30 days for a full refund.');
    db.prepare('INSERT INTO kb(question,answer) VALUES(?,?)').run('What payment methods do you accept?', 'We accept all major credit cards, PayPal and Apple Pay.');
  }
  if (!db.prepare('SELECT 1 FROM flows LIMIT 1').get()) {
    db.prepare('INSERT INTO flows(name,keywords,nodes) VALUES(?,?,?)').run('Lead capture', 'demo, quote, lead, contact me', JSON.stringify([
      { id: 'n1', type: 'message', text: 'Happy to set you up! Let me grab a few details.', next: 'n2' },
      { id: 'n2', type: 'ask', text: "What's your name?", field: 'name', next: 'n3' },
      { id: 'n3', type: 'ask', text: 'And your email address?', field: 'email', next: 'n4' },
      { id: 'n4', type: 'choice', text: 'Thanks! What are you interested in?', options: [{ label: 'Pricing', next: 'n5' }, { label: 'Talk to sales', next: 'n6' }] },
      { id: 'n5', type: 'message', text: 'Our plans start at $19/month — full details on the pricing page.', next: 'n7' },
      { id: 'n6', type: 'handoff', text: 'Great, bringing in our sales team now.' },
      { id: 'n7', type: 'end', text: '' }]));
  }
  if (!db.prepare('SELECT 1 FROM triggers LIMIT 1').get()) {
    db.prepare('INSERT INTO triggers(name,url_contains,delay,message,open_chat) VALUES(?,?,?,?,?)').run('Pricing page help', '/pricing', 15, 'Questions about our plans? I can help you pick the right one.', 0);
  }
  if (!db.prepare('SELECT 1 FROM canned LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO canned(shortcut,text) VALUES(?,?)');
    ins.run('thanks', 'Thanks for reaching out! Is there anything else I can help with?');
    ins.run('hold', 'Thanks for your patience — give me a moment while I look into this.');
    ins.run('bye', 'Glad I could help. Have a wonderful day!');
  }
}
