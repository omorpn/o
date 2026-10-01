import { db } from '../../core/db.js';
import { defineModule } from '../../core/modules.js';
import { registerBotStep } from '../livechat/automation.js';
import { aiAnswer } from '../chatbot/engine.js';

export default defineModule({
  key: 'ai', name: 'AI answers', description: 'Claude answers visitors from your knowledge base when no rule matches (needs ANTHROPIC_API_KEY).',
  init() {
    registerBotStep({ module: 'ai', order: 40, async run(conv, text, { settings, reply }) {
      if (!settings.aiEnabled) return false;
      const hist = db.prepare("SELECT sender, body FROM messages WHERE conv_id=? AND sender IN ('visitor','bot','agent') ORDER BY id DESC LIMIT 10").all(conv.id).reverse()
        .map(m => ({ role: m.sender === 'visitor' ? 'user' : 'assistant', body: m.body }));
      const msgs = []; for (const m of hist) { if (msgs.length && msgs.at(-1).role === m.role) msgs.at(-1).content += '\n' + m.body; else msgs.push({ role: m.role, content: m.body }); }
      while (msgs.length && msgs[0].role !== 'user') msgs.shift();
      const ans = await aiAnswer(conv.site_id, msgs, settings.aiInstructions);
      if (ans) { reply(ans); return true; }
      return false;
    } });
  },
});
