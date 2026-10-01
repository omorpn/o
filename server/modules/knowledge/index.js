/**
 * AI knowledge: teach the bot from your website (crawler or sitemap), documents (PDF, CSV, TXT, Markdown) and pasted
 * text. Answers come from Claude grounded in the best passages (ai module) or, without an API key, from the best
 * matching passage quoted with its source (bot step 30). Unanswered questions are collected for review, the
 * playground shows exactly what the bot would say and why, and stats track answer rates.
 */
import { db, now, getSettings } from '../../core/db.js';
import { fail, str, toInt } from '../../core/http.js';
import { on } from '../../core/events.js';
import { defineModule, isEnabled } from '../../core/modules.js';
import { registerBotStep } from '../livechat/automation.js';
import { matchRule, matchKb, aiAnswer } from '../chatbot/engine.js';
import { matchFlow } from '../flows/engine.js';
import { passagesFor } from '../ai/index.js';
import { LIMITS, assertPublic, syncSource, search, extractiveAnswer, recordMissed, logAnswer, sourceLine } from './service.js';

const TYPES = { pdf: 'pdf', csv: 'csv', txt: 'file', md: 'file', markdown: 'file' };
const aiWillRun = (ws, settings) => !!process.env.ANTHROPIC_API_KEY && isEnabled(ws, 'ai') && settings.aiEnabled;
const srcOut = s => ({ id: s.id, type: s.type, name: s.name, url: s.url, max_pages: s.max_pages, status: s.status, error: s.error, pages: s.pages, chunks: s.chunks, last_synced: s.last_synced, created: s.created });
const ownSource = c => { const s = db.prepare('SELECT * FROM knowledge_sources WHERE id=?').get(c.int('id')); if (!s || !c.auth.siteIds.includes(s.site_id)) fail(404, 'Source not found'); return s; };
const running = new Set();
const queueSync = id => { if (running.has(id)) return; running.add(id); syncSource(id).finally(() => running.delete(id)); };

export default defineModule({
  key: 'knowledge', name: 'AI knowledge', description: 'Train the bot on your website pages, sitemaps, PDFs, CSVs and documents; review missed questions; test in the playground.',
  init() {
    registerBotStep({ module: 'knowledge', order: 30, run(conv, text, { settings, reply }) {
      if (aiWillRun(conv.workspace_id, settings)) return false; // Claude answers from the same passages at step 40
      const a = extractiveAnswer(conv.site_id, text); if (!a) return false;
      reply(a.text + sourceLine(a.sources), ['Talk to a human']);
      logAnswer(conv.site_id, conv.id, text, a.text, 'extractive', a.sources);
      return true;
    } });
    on('bot.unanswered', ({ conv, text }) => {
      if (!isEnabled(conv.workspace_id, 'knowledge') || text.toLowerCase() === 'talk to a human') return;
      recordMissed(conv.site_id, conv.id, text); logAnswer(conv.site_id, conv.id, text, null, 'unanswered');
    });
    // keep crawled websites fresh: re-crawl weekly
    setInterval(() => {
      for (const s of db.prepare("SELECT id FROM knowledge_sources WHERE type IN ('url','sitemap') AND status!='indexing' AND COALESCE(last_synced,0) < ?").all(now() - 7 * 86400_000).slice(0, 5)) queueSync(s.id);
    }, 3600_000).unref();
  },
  routes: [
    { method: 'GET', path: '/api/knowledge/sources', auth: 'ws', perm: 'bot.manage', handler: c => ({
      sources: db.prepare('SELECT * FROM knowledge_sources WHERE site_id=? ORDER BY id DESC').all(c.siteParam()).map(srcOut), limits: LIMITS }) },
    { method: 'POST', path: '/api/knowledge/sources', auth: 'ws', perm: 'bot.manage', handler: async c => {
      const site = c.siteParam(), b = await c.body(14_000_000);
      if (db.prepare('SELECT COUNT(*) n FROM knowledge_sources WHERE site_id=?').get(site).n >= LIMITS.sourcesPerSite) fail(400, `Up to ${LIMITS.sourcesPerSite} sources per website`);
      let row;
      if (b.type === 'url' || b.type === 'sitemap') {
        let url = str(b.url, 1000); if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        try { await assertPublic(url); } catch (e) { fail(400, e.message); }
        row = { type: b.type, name: str(b.name, 120) || new URL(url).hostname + new URL(url).pathname.replace(/\/$/, ''), url, max_pages: Math.max(1, Math.min(LIMITS.maxPages, Math.round(Number(b.max_pages)) || 30)), raw: null };
      } else if (b.type === 'text') {
        const text = str(b.text, 200_000); if (text.length < 20) fail(400, 'Paste at least a few sentences');
        row = { type: 'text', name: str(b.name, 120) || text.slice(0, 50), url: null, max_pages: 1, raw: text };
      } else if (b.type === 'file') {
        const name = str(b.name, 160), ext = name.split('.').pop().toLowerCase(), type = TYPES[ext];
        if (!type) fail(400, 'Upload a PDF, CSV, TXT or Markdown file');
        const data = String(b.data || ''); const size = Math.floor(data.length * 3 / 4);
        if (!size) fail(400, 'Empty file'); if (size > LIMITS.fileBytes) fail(413, 'File too large (max 10 MB)');
        row = { type, name, url: null, max_pages: 1, raw: type === 'file' || type === 'pdf' || type === 'csv' ? data : null };
      } else fail(400, 'Choose a website, sitemap, file or text');
      const id = Number(db.prepare('INSERT INTO knowledge_sources(site_id,type,name,url,max_pages,raw,status,created) VALUES(?,?,?,?,?,?,?,?)').run(site, row.type, row.name, row.url, row.max_pages, row.raw, 'pending', now()).lastInsertRowid);
      c.log('knowledge.source_added', `${row.type}: ${row.url || row.name}`);
      if (row.type === 'url' || row.type === 'sitemap') queueSync(id); else await syncSource(id);
      return { source: srcOut(db.prepare('SELECT * FROM knowledge_sources WHERE id=?').get(id)) };
    } },
    { method: 'POST', path: '/api/knowledge/sources/:id/sync', auth: 'ws', perm: 'bot.manage', handler: c => {
      const s = ownSource(c); if (running.has(s.id)) fail(409, 'Already syncing');
      db.prepare("UPDATE knowledge_sources SET status='indexing' WHERE id=?").run(s.id); queueSync(s.id); return {};
    } },
    { method: 'GET', path: '/api/knowledge/sources/:id/chunks', auth: 'ws', perm: 'bot.manage', handler: c => {
      const s = ownSource(c);
      return { chunks: db.prepare('SELECT id, title, url, substr(content,1,400) content, length(content) size FROM knowledge_chunks WHERE source_id=? ORDER BY id LIMIT 100').all(s.id) };
    } },
    { method: 'DELETE', path: '/api/knowledge/sources/:id', auth: 'ws', perm: 'bot.manage', handler: c => {
      const s = ownSource(c);
      db.prepare('DELETE FROM knowledge_chunks WHERE source_id=?').run(s.id); db.prepare('DELETE FROM knowledge_sources WHERE id=?').run(s.id);
      c.log('knowledge.source_deleted', s.url || s.name); return {};
    } },
    { method: 'GET', path: '/api/knowledge/missed', auth: 'ws', perm: 'bot.manage', handler: c => {
      const st = ['open', 'resolved', 'ignored'].includes(c.query.get('status')) ? c.query.get('status') : 'open';
      return { questions: db.prepare('SELECT id, conv_id, question, count, status, kb_id, created, last_asked FROM missed_questions WHERE site_id=? AND status=? ORDER BY count DESC, last_asked DESC LIMIT 200').all(c.siteParam(), st),
        open: db.prepare("SELECT COUNT(*) n FROM missed_questions WHERE site_id=? AND status='open'").get(c.siteParam()).n };
    } },
    { method: 'POST', path: '/api/knowledge/missed/:id/:action', match: { action: /^(answer|ignore|reopen)$/ }, auth: 'ws', perm: 'bot.manage', handler: async c => {
      const site = c.siteParam(), m = db.prepare('SELECT * FROM missed_questions WHERE id=? AND site_id=?').get(c.int('id'), site) || fail(404, 'Question not found');
      if (c.params.action === 'answer') {
        const b = await c.body(), q = str(b.question, 300) || m.question.slice(0, 300), a = str(b.answer, 3000); if (!a) fail(400, 'Write the answer');
        const kb = db.prepare('INSERT INTO kb(site_id,question,answer) VALUES(?,?,?)').run(site, q, a).lastInsertRowid;
        db.prepare("UPDATE missed_questions SET status='resolved', kb_id=? WHERE id=?").run(kb, m.id);
        return { kb_id: Number(kb) };
      }
      db.prepare('UPDATE missed_questions SET status=? WHERE id=?').run(c.params.action === 'ignore' ? 'ignored' : 'open', m.id); return {};
    } },
    { method: 'POST', path: '/api/knowledge/playground', auth: 'ws', perm: 'bot.manage', handler: async c => {
      const site = c.siteParam(), q = str((await c.body()).question, 1000); if (!q) fail(400, 'Ask a question');
      const settings = getSettings(site), flow = c.moduleOn('flows') && matchFlow(site, q), rule = !flow && c.moduleOn('chatbot') && matchRule(site, q), kb = !flow && !rule && c.moduleOn('chatbot') && matchKb(site, q);
      const passages = search(site, q, 5).map(p => ({ title: p.title, url: p.url, content: p.content.slice(0, 500), coverage: Math.round(p.coverage * 100) }));
      let answer = null, mode = 'none', sources = [];
      if (flow) { answer = flow.nodes[0]?.text || ''; mode = 'flow'; }
      else if (rule) { answer = rule.reply; mode = 'rule'; }
      else if (kb) { answer = kb.answer; mode = 'kb'; }
      else if (process.env.ANTHROPIC_API_KEY && c.moduleOn('ai')) { const a = await aiAnswer(site, [{ role: 'user', content: q }], settings.aiInstructions, passagesFor(c.ws, site, q)); if (a) { answer = a.text; sources = a.sources; mode = 'ai'; } }
      else { const a = extractiveAnswer(site, q); if (a) { answer = a.text; sources = a.sources; mode = 'extractive'; } }
      return { answer: answer ?? settings.fallbackMessage, mode, sources, passages, matched: { flow: flow?.name || null, rule: rule?.name || null, kb: kb?.question || null },
        ai: { configured: !!process.env.ANTHROPIC_API_KEY, enabled: c.moduleOn('ai') && !!settings.aiEnabled } };
    } },
    { method: 'GET', path: '/api/knowledge/stats', auth: 'ws', perm: ['bot.manage', 'analytics.view'], handler: c => {
      const site = c.siteParam(), days = Math.max(1, Math.min(365, toInt(c.query.get('days') || 30))), since = now() - days * 86400_000;
      const by = Object.fromEntries(db.prepare('SELECT mode, COUNT(*) n FROM ai_answers WHERE site_id=? AND created>=? GROUP BY mode').all(site, since).map(r => [r.mode, r.n]));
      const answered = (by.ai || 0) + (by.extractive || 0), total = answered + (by.unanswered || 0);
      const convs = db.prepare("SELECT COUNT(DISTINCT a.conv_id) n, SUM(CASE WHEN c.needs_human=1 OR c.assignee_id IS NOT NULL THEN 1 ELSE 0 END) h FROM (SELECT DISTINCT conv_id FROM ai_answers WHERE site_id=? AND created>=? AND mode IN ('ai','extractive')) a JOIN conversations c ON c.id=a.conv_id").get(site, since);
      const top = db.prepare("SELECT sources FROM ai_answers WHERE site_id=? AND created>=? AND sources IS NOT NULL").all(site, since).flatMap(r => JSON.parse(r.sources)).reduce((m, s) => { const k = s.url || s.title; m[k] = (m[k] || 0) + 1; return m; }, {});
      return { days, answered, unanswered: by.unanswered || 0, ai: by.ai || 0, extractive: by.extractive || 0, answerRate: total ? Math.round(answered / total * 100) : null,
        conversations: convs.n || 0, resolvedWithoutHuman: convs.n ? Math.round((convs.n - (convs.h || 0)) / convs.n * 100) : null,
        topSources: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([source, uses]) => ({ source, uses })),
        recent: db.prepare("SELECT question, answer, mode, created FROM ai_answers WHERE site_id=? ORDER BY id DESC LIMIT 15").all(site) };
    } },
  ],
});
