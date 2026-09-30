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
- **Live visitors** list, overview stats, team management (admin/agent roles), widget appearance & copy settings, allowed-origin control.
- Security: scrypt password hashes, HttpOnly session cookies, rate limits, XSS-safe rendering, path-traversal guard.

## Install on your site
```html
<script src="https://YOUR-HOST/widget.js" data-key="SITE_KEY" async></script>
```
Site key is shown in Settings → Install. Env vars: `PORT`, `DB_FILE` (default `data/chatly.db`).

## Layout
`server/` API + SSE realtime + SQLite · `public/widget.js` · `public/app/` dashboard SPA · `test/smoke.mjs`
