# Chatly architecture

Chatly is a modular monolith: one Node process, a core layer, and feature **modules** that plug into it.
No npm dependencies (Node ≥ 22.13, built-in `node:sqlite`).

```
server/
├── index.js              boot: load modules → init → HTTP server (static + API)
├── core/                 foundations every module uses
│   ├── db.js             SQLite schema, tenants (workspaces/sites), settings, seeding
│   ├── http.js           JSON responses, errors, body parsing, rate limits, client IP
│   ├── router.js         declarative routes: auth level, permission, module gating
│   ├── auth.js           sessions, membership, permissions, audit logs
│   ├── rbac.js           permission catalogue + default roles
│   ├── realtime.js       Server-Sent Events hub, scoped per workspace/website/permission
│   ├── events.js         in-process event bus
│   ├── modules.js        module registry, per-workspace toggles, plan availability
│   ├── mail.js           dependency-free SMTP client
│   └── text.js           keyword matching shared by automation
└── modules/
    ├── auth/             sign-in, sign-up, profile, workspace switching           (core)
    ├── workspace/        websites, team, roles, module toggles, audit log         (core)
    ├── livechat/         widget API, inbox, visitors, saved replies, settings,    (core)
    │                     automation pipeline (bot steps), visitor emails
    ├── notifications/    in-app center, email, Web Push, preferences, alerts      (core)
    ├── departments/      teams, automatic assignment (round robin / least busy), queue
    ├── platform/         operator console, plans × modules                        (core)
    ├── fraud/            risk engine, review queue, blocklists                    (core)
    ├── chatbot/          keyword rules + knowledge base (bot step 20)
    ├── flows/            guided flows engine + API (bot step 10)
    ├── ai/               Claude answers from the knowledge base (bot step 40)
    ├── triggers/         proactive messages
    ├── contacts/         contacts, notes, history, CSV export
    ├── analytics/        reports
    ├── spam/             per-business spam tools
    └── webhooks/         forwards events to each website's webhook URL

public/
├── widget.js             embeddable chat widget (Shadow DOM)
└── app/                  dashboard
    ├── index.html, style.css, sw.js (push service worker)
    └── js/               ES modules: core, shell, realtime, notifications, inbox, contacts,
                          visitors, triggers, chatbot, dashboard, settings, platform, auth, main
```

## Writing a module

```js
import { defineModule } from '../../core/modules.js';
import { on } from '../../core/events.js';

export default defineModule({
  key: 'tickets', name: 'Tickets', description: 'Email & chat tickets with SLAs.',
  init() { on('conversation.closed', ({ conv }) => { /* react to other modules */ }); },
  routes: [
    { method: 'GET', path: '/api/tickets', auth: 'ws', perm: 'tickets.view', handler: c => ({ tickets: [] }) },
    { method: 'POST', path: '/api/tickets/:id/reply', auth: 'ws', perm: 'tickets.reply', handler: async c => { const b = await c.body(); return {}; } },
  ],
});
```

Then import it in `server/index.js`. The router enforces, in order: signed in → member of an active
(non-suspended) workspace → **module enabled for that workspace and its plan** → permission. Handlers get `c`:
`c.me`, `c.ws`, `c.body()`, `c.int('id')`, `c.q('name')`, `c.need(perm)`, `c.can(perm)`, `c.siteParam()`,
`c.scopeSites()`, `c.log(action, detail)`, `c.moduleOn(key)`.

Auth levels: `public` · `user` (signed in) · `ws` (workspace member, module gated) · `platform` (operators).

## Events

| Event | Published by | Payload |
|---|---|---|
| `conversation.created` | livechat | `{ conv }` |
| `message.created` | livechat (every message) | `{ conv, message, senderId }` |
| `conversation.handoff` | livechat | `{ conv, teamOnline }` |
| `conversation.assigned` | livechat | `{ conv, assigneeId, by }` |
| `conversation.closed` | livechat | `{ conv, by }` |
| `conversation.rated` | livechat widget | `{ conv, rating, comment }` |
| `note.created` | livechat | `{ conv, message, by }` |
| `visitor.identified` | livechat | `{ visitor }` |
| `flow.answer` | flows | `{ conv, field, value }` |
| `member.added` | workspace | `{ ws, user, role, by, created }` |
| `module.toggled` | workspace | `{ ws, module, enabled }` |
| `workspace.created` | auth | `{ ws, name, owner }` |
| `workspace.suspended` / `.reactivated` | fraud / platform | `{ ws, reason }` |
| `workspace.plan_changed` | platform | `{ ws, plan }` |
| `platform.announcement` | platform | `{ text, by }` |
| `fraud.detected` | fraud | `{ kind, score, action, workspaceId, summary }` |
| `agent.online` | livechat | `{ userId, ws }` |

Subscribers today: **notifications** (team/platform alerts), **webhooks** (outbound HTTP), **livechat** (visitor emails).

## Notifications

`notify(userIds, { type, title, body, link, ws, ... })` in `modules/notifications` delivers through:
- **in-app**: stored + pushed over SSE (`notification` event) → bell, toast, desktop alert;
- **email**: only when the user isn't online in the dashboard, respecting the website's email switch;
- **Web Push**: VAPID-signed, aes128gcm-encrypted (RFC 8291/8292) to registered browsers, cleaned up on 404/410.

Preferences are per user × type × channel, plus quiet hours. Throttling prevents floods (per conversation,
fraud alerts batched every 10 min). A background check raises "visitor waiting too long" alerts per website target.

## Scaling notes

Single process + SQLite + in-memory realtime and event bus. To scale horizontally: Postgres, Redis pub/sub for
`core/realtime.js` and `core/events.js` (they are the only in-memory fan-out points), object storage for uploads,
and a job queue for notifications/webhooks.
