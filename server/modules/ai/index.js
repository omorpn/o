/** AI answers: Claude replies from the knowledge base and the website's knowledge sources, citing them (bot step 40). */
import { db } from '../../core/db.js';
import { defineModule, isEnabled } from '../../core/modules.js';
import { registerBotStep } from '../livechat/automation.js';
import { aiAnswer } from '../chatbot/engine.js';
import { search, logAnswer, sourceLine } from '../knowledge/service.js';

/** Recent conversation as alternating user/assistant turns, starting with the visitor. */
export function historyOf(convId) {
  const hist = db.prepare("SELECT sender, body FROM messages WHERE conv_id=? AND sender IN ('visitor','bot','agent') ORDER BY id DESC LIMIT 10").all(convId).reverse()
    .map(m => ({ role: m.sender === 'visitor' ? 'user' : 'assistant', body: m.body }));
  const msgs = []; for (const m of hist) { if (msgs.length && msgs.at(-1).role === m.role) msgs.at(-1).content += '\n' + m.body; else msgs.push({ role: m.role, content: m.body }); }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}
/** Passages for the question when the AI knowledge module is on for the workspace. */
export const passagesFor = (ws, siteId, text) => (isEnabled(ws, 'knowledge') ? search(siteId, text, 6).filter(p => p.coverage > 0) : []);

export default defineModule({
  key: 'ai', name: 'AI answers', description: 'Claude answers visitors from your knowledge base and knowledge sources when no rule matches (needs ANTHROPIC_API_KEY).',
  init() {
    registerBotStep({ module: 'ai', order: 40, async run(conv, text, { settings, reply }) {
      if (!settings.aiEnabled) return false;
      const ans = await aiAnswer(conv.site_id, historyOf(conv.id), settings.aiInstructions, passagesFor(conv.workspace_id, conv.site_id, text));
      if (!ans) return false;
      reply(ans.text + sourceLine(ans.sources));
      logAnswer(conv.site_id, conv.id, text, ans.text, 'ai', ans.sources);
      return true;
    } });
  },
});
