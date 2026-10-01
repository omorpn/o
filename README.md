# Chatly — self-hosted live chat, chatbot & shared inbox (Tidio-style)

Zero npm dependencies. Requires Node ≥ 22.13 (uses built-in `node:sqlite`).

```bash
npm start            # http://localhost:3000
npm test             # 6 suites: end-to-end, permissions/isolation, platform, fraud, modules, notifications
```

- **Demo site** `/` — has the widget installed
- **Dashboard** `/app/` — sign up, or use the seeded owner `admin@example.com` / `admin123` (override with `ADMIN_EMAIL`, `ADMIN_PASSWORD` on first run)

## Multi-workspace platform
- **Self-service sign-up** at `/app/` → every business gets its own **workspace** (fully isolated data), with any number of **websites**, each with its own install key, widget settings, chatbot, flows, knowledge base and triggers.
- **Roles & permissions**: Owner, Admin, Supervisor, Agent, Viewer + custom roles built from 23 permissions (e.g. `chats.view_all`, `chats.reply`, `chats.assign`, `contacts.export`, `bot.manage`, `settings.manage`, `team.manage`, `roles.manage`, `audit.view`). Teammates can be limited to specific websites.
- Enforced on the server for every API call **and every realtime event**; no privilege escalation (you can only grant permissions you hold; admins can't touch owners; the last Owner can't be removed). Role changes apply instantly to connected users.
- One login can belong to several workspaces (agencies) and switch between them; **audit log** of team, role, website and settings changes; install-key rotation.
- Env: `ALLOW_SIGNUP=0` to disable public sign-up, `DEMO=0` to hide the demo page's key.

## Architecture
A modular monolith: `server/core/` (router, auth & permissions, realtime, **event bus**, **module registry**, db, mail) plus
feature modules in `server/modules/` (livechat, chatbot, flows, ai, triggers, contacts, analytics, spam, webhooks,
notifications, fraud, platform, workspace, auth). The dashboard is split into ES modules under `public/app/js/`.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the spec coverage map in [docs/ROADMAP.md](docs/ROADMAP.md).

## Modules & plans
Each business can switch feature modules on/off (Settings → Modules); the platform decides which modules each plan
includes (Platform console → Plans & modules). Disabled modules are enforced on the server: their API returns a clear
403, the widget stops running them (e.g. no triggers, no bot) and the dashboard hides them.

## Notifications
A bell with unread count and a notification center; realtime toasts and desktop alerts; **email** when you're away;
**Web Push** to your browser even when the dashboard is closed (VAPID keys auto-generated, or set `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). Per-user preferences per type × channel and quiet hours. Types: new conversation,
visitor asks for a human, new message in my chats, assigned to me, @mentioned in a note, visitor waiting too long
(per-website response target), chat rated, added to a workspace, workspace suspended, announcements; platform admins
also get new sign-ups and fraud alerts. Set `PUBLIC_URL` so links in emails and pushes point at your domain.

## Platform console (for you, the operator)
The first account (plus anyone in `PLATFORM_ADMINS=a@x.com,b@y.com`) is a **platform admin** and gets *Platform console* in the sidebar:
- **Overview** of every workspace, user, website install, sign-ups over time, plans and the busiest workspaces.
- **Workspaces**: search, change plan, **suspend** (blocks dashboard, widget and live chats with a reason shown to the customer), reactivate, delete.
- **Users**: disable/enable, reset password, grant/revoke platform admin.
- **Platform settings**: open/close sign-up, announcement banner, plan names. **Platform audit** of every operator action.

## Fraud & abuse detection
Every risky action gets an explainable 0–100+ risk score; at the review threshold it lands in the **review queue**, at the block threshold it's blocked (or only logged in *monitor* mode).
- **Sign-up fraud**: honeypot field, bot-speed form fills, disposable email domains, sign-up velocity per IP, bot user agents, blocklisted IP/email/domain.
- **Account takeover**: progressive account lock after repeated wrong passwords, automatic 1-hour IP block for credential stuffing, alert on sign-in from a new network right after failures.
- **Visitor spam**: links, URL shorteners, suspicious TLDs, scam/spam phrases, platform-wide **spam-campaign** detection (same message from many visitors), flooding, many identities per IP, bots. High-risk messages are silently dropped; borderline ones are delivered marked "⚠ spam?".
- **Platform abuse**: agents sending phishing (credential requests with links, shorteners) are blocked; workspaces get a rolling **risk score**, with optional **auto-suspend**.
- **Review queue**: confirm (block IP / email / domain / visitor, disable user, suspend workspace) or dismiss; platform-wide blocklist; unlock accounts; thresholds and mode.
- **For each business**: 🚫 block/report visitors from the inbox (optionally by IP), *Spam protection* settings (filter Off/Normal/Strict, own blocked words/IPs, recent spam activity). Permission: `chats.block`.

## Features
- **Embeddable widget** (`/widget.js`, Shadow-DOM isolated): launcher, proactive greeting bubble, quick-reply buttons, typing indicators, unread badge, email capture, persistent visitor identity and history, live page tracking.
- **Shared inbox**: realtime conversations, filters (mine / unassigned / needs human / snoozed / closed / priority / department / assignee), search, assign, close/reopen, **priority**, **snooze** (wakes up on time or when the visitor writes), personal and shared **saved views**, **bulk actions**, internal notes, saved replies (`/shortcut`), sound + desktop notifications, visitor details.
- **Departments & routing**: teams like Sales or Support, automatic assignment (**round robin** or **least busy**) to agents who are online and *Available*, max open chats per agent with a waiting queue, transfers between departments, a department picker in the widget, and flows that hand over to a specific department.
- **AI knowledge**: add your website (crawler or sitemap), PDFs, CSVs and documents; the bot answers from the most relevant passages — written by Claude with source links when `ANTHROPIC_API_KEY` is set, quoted from the source otherwise. Questions it couldn't answer are collected so you can answer them once; a playground and answer-rate stats show how it performs.
- **Billing**: sell your plans in ₦ or $ with Paystack, Flutterwave or Stripe — monthly or yearly, automatic Paystack card renewals, reminders and a grace period, invoices, seat and website limits per plan, and a revenue view for the platform owner.
- **Tickets**: create manually or from a chat (transcript attached), statuses open → pending → solved → closed (auto-close), priorities with first-response and resolution SLA targets and breach alerts, assignee, department, tags, custom fields, internal notes, merge, full history, bulk actions.
- **Email channel**: connect support@yourshop.com through Postmark, Mailgun, SendGrid, a Cloudflare Email Worker or any forwarder; emails become tickets, replies thread back onto the same ticket (and reopen it), agents answer by email with signatures, auto-acknowledgements, and loop/duplicate/out-of-office protection.
- **Account security**: email verification, password reset by email, authenticator-app 2FA with recovery codes, active sessions with remote sign-out, sign-in history, data export and account deletion.
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


## Scaling honestly
This build runs as **one server process with SQLite**; realtime fan-out lives in memory. That comfortably serves many small/medium businesses on one machine, but **not** a million websites. For that scale the next steps are: Postgres instead of SQLite, Redis pub/sub for realtime across many instances, object storage for uploads, and a load balancer — plus billing/plan limits.

## Widget not showing?
1. Settings → Websites: the status line says whether the widget was detected, or why it was blocked.
2. Press **Test widget** — if it works there, the problem is on your site's side.
3. Open your site's browser console (F12): Chatly logs the exact reason (`[Chatly] Widget not started: …`).
4. Common causes: the site isn't in **Allowed origins** (Settings → Widget; `*` allows all), an old snippet after the key was rotated, or a strict Content-Security-Policy on your site (allow the Chatly host in `script-src` and `connect-src`).
