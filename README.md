# Chatly — self-hosted live chat, chatbot & shared inbox (Tidio-style)

Zero npm dependencies. Requires Node ≥ 22.13 (uses built-in `node:sqlite`).

```bash
npm start            # http://localhost:3000
npm test             # end-to-end + permissions/isolation tests
```

- **Demo site** `/` — has the widget installed
- **Dashboard** `/app/` — sign up, or use the seeded owner `admin@example.com` / `admin123` (override with `ADMIN_EMAIL`, `ADMIN_PASSWORD` on first run)

## Multi-workspace platform
- **Self-service sign-up** at `/app/` → every business gets its own **workspace** (fully isolated data), with any number of **websites**, each with its own install key, widget settings, chatbot, flows, knowledge base and triggers.
- **Roles & permissions**: Owner, Admin, Supervisor, Agent, Viewer + custom roles built from 18 permissions (e.g. `chats.view_all`, `chats.reply`, `chats.assign`, `contacts.export`, `bot.manage`, `settings.manage`, `team.manage`, `roles.manage`, `audit.view`). Teammates can be limited to specific websites.
- Enforced on the server for every API call **and every realtime event**; no privilege escalation (you can only grant permissions you hold; admins can't touch owners; the last Owner can't be removed). Role changes apply instantly to connected users.
- One login can belong to several workspaces (agencies) and switch between them; **audit log** of team, role, website and settings changes; install-key rotation.
- Env: `ALLOW_SIGNUP=0` to disable public sign-up, `DEMO=0` to hide the demo page's key.

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
<script src="https://YOUR-HOST/widget.js?key=SITE_KEY" data-key="SITE_KEY" async></script>
```
Each website's snippet is in Settings → Websites, which also shows whether the widget has been detected on your site (or why it was blocked) and has a **Test widget** button. Env vars: `PORT`, `DB_FILE` (default `data/chatly.db`).

## Layout
`server/` API + SSE realtime + SQLite · `public/widget.js` · `public/app/` dashboard SPA · `test/smoke.mjs`

## Scaling honestly
This build runs as **one server process with SQLite**; realtime fan-out lives in memory. That comfortably serves many small/medium businesses on one machine, but **not** a million websites. For that scale the next steps are: Postgres instead of SQLite, Redis pub/sub for realtime across many instances, object storage for uploads, and a load balancer — plus billing/plan limits.

## Widget not showing?
1. Settings → Websites: the status line says whether the widget was detected, or why it was blocked.
2. Press **Test widget** — if it works there, the problem is on your site's side.
3. Open your site's browser console (F12): Chatly logs the exact reason (`[Chatly] Widget not started: …`).
4. Common causes: the site isn't in **Allowed origins** (Settings → Widget; `*` allows all), an old snippet after the key was rotated, or a strict Content-Security-Policy on your site (allow the Chatly host in `script-src` and `connect-src`).
