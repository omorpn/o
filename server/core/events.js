/**
 * In-process event bus. Feature modules publish domain events ("message.created", "conversation.assigned", …)
 * and other modules (notifications, webhooks, email) subscribe without the publisher knowing about them.
 * Handlers run after the current request work (microtask) and never break the publisher.
 */
const handlers = new Map();

export function on(event, fn) {
  if (!handlers.has(event)) handlers.set(event, []);
  handlers.get(event).push(fn);
}

export function emit(event, payload) {
  for (const fn of [...(handlers.get(event) || []), ...(handlers.get('*') || [])]) {
    queueMicrotask(async () => {
      try { await fn(payload, event); } catch (e) { console.error(`[events] ${event} handler failed:`, e); }
    });
  }
}

/** Names of events that have at least one subscriber (for the architecture docs / debugging). */
export const subscribed = () => [...handlers.keys()];
