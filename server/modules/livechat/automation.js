/**
 * Bot pipeline. Automation modules (flows, chatbot rules, knowledge base, AI) register ordered steps;
 * for each visitor message the first enabled step that handles it wins, otherwise the fallback is sent.
 */
import { db, getSettings } from '../../core/db.js';
import { isEnabled } from '../../core/modules.js';
import { emit } from '../../core/events.js';
import { toVisitor } from '../../core/realtime.js';
import { getConv, addMessage, handoff } from './service.js';

export const HUMAN_PHRASE = 'talk to a human';
const steps = [];

/** @param {{module: string, order: number, run: (conv, text, ctx) => boolean|Promise<boolean>}} step */
export function registerBotStep(step) { steps.push(step); steps.sort((a, b) => a.order - b.order); }

/** True when any automation module is on, i.e. new conversations should start with the bot. */
export const automationOn = ws => steps.some(s => isEnabled(ws, s.module));

export function botRespond(convId, text) {
  const conv = getConv(convId);
  if (!conv || !conv.bot_active) return;
  const ws = conv.workspace_id;
  const active = steps.filter(s => isEnabled(ws, s.module));
  if (!active.length) return;
  const settings = getSettings(conv.site_id);
  const reply = (body, buttons) => addMessage(getConv(convId), 'bot', body, { senderName: 'Bot', buttons });
  toVisitor(conv.visitor_id, 'typing', { who: 'bot' });
  setTimeout(async () => {
    try {
      const cur = getConv(convId);
      if (!cur || !cur.bot_active) return;
      if (text.toLowerCase() === HUMAN_PHRASE) return handoff(cur);
      for (const step of active) {
        if (!getConv(convId)?.bot_active) return;
        if (await step.run(getConv(convId), text, { settings, reply, db })) return;
      }
      if (getConv(convId)?.bot_active) { reply(settings.fallbackMessage, ['Talk to a human']); emit('bot.unanswered', { conv: getConv(convId), text }); }
    } catch (e) { console.error('bot error', e); }
  }, 700);
}
