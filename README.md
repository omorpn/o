# Chatly — self-hosted live chat, chatbot & shared inbox (Tidio-style)

Zero npm dependencies. Requires Node ≥ 22.13 (uses built-in `node:sqlite`).

```bash
npm start            # http://localhost:3000
npm test             # end-to-end smoke tests
```

- **Demo site** `/` — has the widget installed
- **Dashboard** `/app/` — default login `admin@example.com` / `admin123` (override with `ADMIN_EMAIL`, `ADMIN_PASSWORD` on first run)

## Features
- **Embeddable widget** (`/widget.js`, Shadow-DOM isolated): launcher, proactive greeting bubble, quick-reply buttons, typing indicators, unread badge, email capture, persistent visitor identity and history, live page tracking.
- **Shared inbox**: realtime conversations, filters (mine / unassigned / needs human / closed), search, assign, close/reopen, internal notes, saved replies (`/shortcut`), sound + desktop notifications, visitor details.
- **Chatbot builder**: keyword rules with replies, buttons and human handoff; built-in tester; bot stops once an agent replies; offline message when no agent is online.
- **Flows**: visual step-by-step conversation builder (messages, choices, questions that save name/email/phone, human handoff) triggered by keywords.
- **Email** (built-in SMTP client, no dependencies): notify the team when nobody is online, email agent replies to visitors who left, email transcripts on close. Configure `SMTP_URL` (`smtp://user:pass@host:587` STARTTLS or `smtps://…:465`) and `SMTP_FROM`.
- **Contacts** CRM-lite (search, profile drawer, notes, conversation history), **conversation tags** with filters, **triggers** (URL + delay targeted messages / auto-open), **pre-chat form**, widget themes (light/dark/auto, gradient, pill launcher, avatar) with a **live preview**, emoji pickers, dark mode dashboard, onboarding checklist.
- **Knowledge base + AI answers**: Q&A entries answer automatically; set `ANTHROPIC_API_KEY` (optionally `AI_MODEL`) and enable AI to have Claude answer from the knowledge base, handing off when unsure.
- **Attachments** (images, PDF, text, ≤3 MB) both ways; **satisfaction ratings** when a chat closes; **business hours** with timezone; **webhooks** (`conversation.created`, `message.created`, `visitor.identified`, `conversation.closed`, `conversation.rated`); **analytics** (14-day chart, first-response time, CSAT, bot-only %); transcript and contacts CSV export.
- **Live visitors** list, overview stats, team management (admin/agent roles), widget appearance & copy settings, allowed-origin control.
- Security: scrypt password hashes, HttpOnly session cookies, rate limits, XSS-safe rendering, path-traversal guard.

## Install on your site
```html
<script src="https://YOUR-HOST/widget.js" data-key="SITE_KEY" async></script>
```
Site key is shown in Settings → Install. Env vars: `PORT`, `DB_FILE` (default `data/chatly.db`).

## Layout
`server/` API + SSE realtime + SQLite · `public/widget.js` · `public/app/` dashboard SPA · `test/smoke.mjs`
