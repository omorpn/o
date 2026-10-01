# Roadmap against the product specification

This maps the "Customer Communication & AI Platform" specification (≈1,020 capabilities, 89 sections) onto what
Chatly does today. ✅ built and tested · 🟡 partly built · ⬜ not started.

## Build phases (spec §85)

| Phase | Scope | Status |
|---|---|---|
| 1 — Foundation | multi-tenant accounts, auth, users, roles, permissions, workspace, website install, live chat, unified inbox, contacts | ✅ (gap: organizations above workspaces) |
| 2 — Support | tickets, ticket assignment, departments, tags, internal notes, macros, search, customer history, email, notifications | 🟡 tickets, departments, tags, notes, saved replies, search, history, notifications ✅ · inbound email ✅ · macros ⬜ |
| 3 — Automation | flow builder, triggers, conditions, actions, forms, webhooks, lead capture, surveys, routing, templates | 🟡 step flows, URL/delay triggers, webhooks, lead capture, CSAT ✅ · visual canvas, conditions, flow actions, templates, routing ⬜ |
| 4 — AI | AI agent, knowledge base, crawler, PDF/CSV knowledge, guidance, playground, missed questions, handoff, AI analytics | 🟡 Claude answers grounded in Q&A + crawled pages/sitemaps/PDF/CSV/text with citations, extractive answers without a key, handoff, playground, missed questions, AI analytics ✅ · AI actions, copilot, guidance library ⬜ |
| 5 — Ecommerce | products, inventory, orders, cart, recommendations, order/shipping lookup, discounts, refunds, attribution | ⬜ |
| 6 — Omnichannel | WhatsApp, Instagram, Messenger, email, channel routing, unified history | ⬜ (needs Meta Business / WhatsApp Cloud API accounts) |
| 7 — Advanced AI | AI actions, OpenAPI, MCP, external APIs, tool permissions, action logs, memory, copilot | ⬜ |
| 8 — Enterprise | SSO, audit logs, advanced analytics, custom roles, security, API, SDK, data export | 🟡 audit logs, custom roles ✅ · SSO, public API keys, data export ⬜ |

## By section

| § | Area | Status | Notes |
|---|---|---|---|
| 1.1 | Multi-tenant architecture | 🟡 | Workspaces → websites, isolation, per-tenant settings/automation/analytics ✅. No "organization" level above workspaces; billing per tenant ⬜ |
| 1.2 | Account management | ✅ | Registration, email verification, self-service password reset, TOTP 2FA + recovery codes, device/session list with remote sign-out, login history, data export, account deletion ✅. SSO/SAML ⬜ |
| 1.3 | Workspace setup | 🟡 | Name, website URL, business hours, timezone ✅. Logo, description, category, contact info, language, currency ⬜ |
| 2 | Users & team | 🟡 | Invitations, Owner/Admin/Supervisor/Agent/Viewer + custom roles, 19 permissions, website-level access, online status ✅. Departments, Available/Away status ✅. Agent profiles, billing/API/AI-specific permissions ⬜ |
| 3 | Departments & routing | 🟡 | Departments (members, colour, public/internal), manual / round-robin / least-busy assignment, max concurrent chats, queue that drains when agents become free, transfer between departments, widget department picker, flow handoff to a department, department-scoped notifications, SLA alert ✅. Skills, escalation rules, business-hours per department ⬜ |
| 4 | Omnichannel inbox | 🟡 | One inbox, search, filters (status/mine/unassigned/needs human/tag/website/priority/department/assignee/date), unread, priority, snooze with auto wake-up, personal + shared saved views, bulk actions (close/reopen/read/assign/priority/department/tag/snooze/delete) ✅. Channel filters ⬜ |
| 5 | Live chat | ✅ | Widget, realtime, typing, presence, attachments, emoji, timestamps, transcripts, close/reopen, transfer, takeover, notes, @mentions. Read receipts ⬜ |
| 6 | Proactive chat | 🟡 | Greeting, time, URL/page triggers, auto-open ✅. Location, device, new/returning, scroll, exit-intent, cart/checkout, custom JS triggers ⬜ |
| 7 | Visitor monitoring | 🟡 | Live list, current page, browser, returning visits ✅. Location, referrer, landing page, page trail, session duration, segments ⬜ |
| 8 | Contact / mini CRM | 🟡 | Records, name/email, notes, history, search, export ✅. Phone, location, contact tags, custom properties, lead/customer status, purchases ⬜ |
| 9–10 | Ticketing | ✅ | Manual + from-chat tickets, per-workspace numbering, open/pending/solved/closed, priority, assignee, department, tags, custom fields (text/number/dropdown/checkbox), first-response + resolution SLA per priority with breach alerts, auto-close, reopen, public replies + internal notes, merge, full change history, requester's other tickets, bulk actions, realtime, webhooks, 4 ticket permissions. Macros, ticket forms for customers ⬜ |
| 11 | Email channel | ✅ | Support mailboxes with a private inbound URL (Postmark, Mailgun, SendGrid, Cloudflare Email Workers, raw MIME, JSON), email → ticket with attachments, threading by Message-ID / In-Reply-To / [#n], quoted-text stripping, reopen on reply, follow-up tickets for closed ones, auto-acknowledgement, signatures, Reply-To, loop/duplicate/auto-reply/blocklist protection, send-failure notes. IMAP polling, HTML email, CC handling ⬜ |
| 12–21 | AI agent, knowledge, playground, guidance, actions, handoff, missed questions, copilot | 🟡 | Knowledge sources (website crawler with robots.txt + SSRF guard, sitemaps, PDF, CSV, TXT/MD, pasted text; weekly re-crawl), FTS5/BM25 retrieval, Claude answers with source citations and HANDOFF when unsure, quoted answers without an AI key, missed-question review → Q&A, playground showing which step answers and why, answer-rate / resolved-without-human stats ✅. AI actions (order lookup etc.), agent copilot, per-topic guidance ⬜ |
| 22–26 | Flows | 🟡 | Step flows (message, choice, question → name/email/phone, handoff, end), keyword trigger ✅. Visual canvas, conditions, delays, API/webhook nodes, templates, analytics ⬜ |
| 27–29 | Leads, sales, ecommerce | ⬜ | Lead capture via flows only |
| 30–33 | Social channels | ⬜ | Requires Meta app review + WhatsApp Business account |
| 34 | Widget customization | 🟡 | Color, gradient, avatar, position, theme, launcher style, branding toggle, welcome message, pre-chat form, live preview ✅. Language, mobile/desktop visibility, custom CSS ⬜ |
| 35 | Multilingual | ⬜ | |
| 36 | Customer feedback | 🟡 | CSAT stars + comment, rating history, low-rating notification ✅. Surveys, export ⬜ |
| 37–43 | Analytics & reporting | 🟡 | Overview, 14-day volume, first response, CSAT, bot share, per-agent ✅. Date ranges, AI/lead/sales/flow analytics, exports, scheduled reports ⬜ |
| 44–45 | Search & tags | 🟡 | Conversation/contact search, conversation tags + filter + counts ✅ |
| 46 | Macros | 🟡 | Shared saved replies with `/shortcut` ✅. Categories, private, variables ⬜ |
| 47–48 | Collaboration & notifications | ✅ | Notes, @mentions, assignment, presence, in-app/email/browser push notifications, preferences, quiet hours, SLA warnings |
| 49 | Apps | 🟡 | Responsive web app + Web Push (installable PWA next). Native apps ⬜ |
| 50, 53 | Integrations | 🟡 | Webhooks (Zapier/Make/n8n compatible) ✅. Native Shopify/HubSpot/etc. ⬜ |
| 51 | Developer platform | 🟡 | Widget JS API, webhooks ✅. Public REST API keys, signing, retries, docs ⬜ |
| 52 | MCP | ⬜ | |
| 54 | Security | 🟡 | RBAC, audit logs, rate limits, fraud detection, account lockout, HTTPS via host ✅. Encryption at rest, retention controls, webhook signing ⬜ |
| 55–56 | Enterprise, billing | 🟡 | Super admin console, plans × modules ✅. SSO, payments/invoices (Stripe/Paystack/Flutterwave) ⬜ |
| 58 | Audit & logging | 🟡 | Workspace + platform audit logs ✅ |
| 60–61 | Message / realtime engine | 🟡 | SSE realtime with reconnection, presence, typing, scoped delivery ✅. Edit/delete, reactions, read state ⬜ |
| 64 | SLA | 🟡 | First-response target per website + alerts ✅. Policies, resolution SLA, breach analytics ⬜ |
| 66 | AI safety | 🟡 | Knowledge-only answers, handoff when unsure ✅ |
| 70 | Platform performance | ⬜ | Single process today — see ARCHITECTURE.md scaling notes |
| 87 | Nigerian commerce (NGN, Paystack, Flutterwave, WhatsApp ordering, delivery zones, riders) | ⬜ | Fits Phase 5 + 6 |

## Recommended next steps

1. **WhatsApp Cloud API** channel (needs a Meta Business account and verified number).

## Billing (done)
Paystack, Flutterwave and Stripe checkout; NGN/USD monthly & yearly prices and seat/website limits per plan (Platform → Billing & revenue); payments confirmed with the provider on return and via signed webhooks with amount/currency checks; invoices; Paystack saved-card auto-renewal; reminders, 3-day grace, downgrade to the free plan; cancel/resume; revenue overview. Proration and tax/VAT invoices ⬜.
