import { S, ago, api, appendTo, avEl, can, guard, h, icon, toast, mod } from './core.js';
import { renderNotificationPrefs } from './notifications.js';
import { renderAccount } from './account.js';
import { renderDepartments } from './departments.js';
import { renderTicketSettings } from './tickets.js';
import { installStatus, siteBar, snippet } from './dashboard.js';
import { actionPill } from './platform.js';
import { boot, renderShell } from './shell.js';

// ---------- settings ----------
export let settingsTab = 'widget';
export const openSettingsTab = t => { settingsTab = t; };
export async function renderSettings(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const TABS = [['widget', 'Widget', 'settings.manage'], ['sites', 'Websites'], ['canned', 'Saved replies'], ['team', 'Team', 'team.manage'], ['departments', 'Departments & routing', 'team.manage', 'departments'], ['tickets', 'Tickets', 'tickets.view', 'tickets'], ['roles', 'Roles & permissions', 'roles.manage'],
    ['modules', 'Modules', ['workspace.manage', 'settings.manage']], ['spam', 'Spam protection', 'chats.block', 'spam'], ['notifications', 'Notifications'], ['audit', 'Audit log', 'audit.view'], ['workspace', 'Workspace'], ['account', 'My account']]
    .filter(t => (!t[2] || [].concat(t[2]).some(can)) && (!t[3] || mod(t[3])));
  if (!TABS.some(t => t[0] === settingsTab)) settingsTab = TABS[0][0];
  appendTo(page, h('h2', {}, 'Settings'), h('div', { class: 'tabs' }, ...TABS.map(([k, l]) => h('button', { class: settingsTab === k ? 'on' : '', onclick: () => { settingsTab = k; renderShell(); } }, l))));
  const admin = can('settings.manage');
  if (settingsTab === 'widget') {
    appendTo(page, siteBar());

    const { settings: s } = await api('/settings');
    const KEYS = ['title', 'subtitle', 'brandName', 'color', 'position', 'gradient', 'launcherStyle', 'launcherLabel', 'avatarUrl', 'theme', 'showBranding', 'prechatForm', 'greeting', 'fallbackMessage', 'handoffMessage', 'offlineMessage',
      'askEmail', 'ratingEnabled', 'proactiveEnabled', 'proactiveDelay', 'proactiveMessage', 'allowedOrigins', 'businessHoursEnabled', 'hoursStart', 'hoursEnd', 'hoursDays', 'timezone', 'webhookUrl', 'emailNotifications', 'emailReplies', 'emailTranscript'];
    const g = k => { const e = document.getElementById('s_' + k); return !e ? s[k] : e.type === 'checkbox' ? e.checked : e.value; };
    const upd = () => drawPreview();
    const inp = (k, label, type = 'text', hint) => [h('label', {}, label), h('input', { id: 's_' + k, type, value: s[k], disabled: !admin, oninput: upd }), hint ? h('div', { class: 'hint' }, hint) : null];
    const txt = (k, label) => [h('label', {}, label), h('textarea', { id: 's_' + k, rows: 2, disabled: !admin, oninput: upd }, s[k])];
    const chk = (k, label) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', id: 's_' + k, checked: s[k], disabled: !admin, onchange: upd }), label);
    const sel = (k, label, opts) => [h('label', {}, label), h('select', { id: 's_' + k, disabled: !admin, onchange: upd }, ...opts.map(([v, l]) => h('option', { value: v, selected: s[k] === v }, l)))];
    const preview = h('div', { class: 'preview' });
    function drawPreview() {
      const c = /^#[0-9a-f]{6}$/i.test(g('color')) ? g('color') : '#6366f1', dark = g('theme') === 'dark', right = g('position') !== 'left', pill = g('launcherStyle') === 'pill';
      const av = g('avatarUrl');
      const head = g('gradient') ? `linear-gradient(135deg,${c},color-mix(in srgb,${c} 65%,#000))` : c;
      preview.replaceChildren(
        h('div', { class: 'pv-panel' + (dark ? ' dark' : '') }, h('div', { class: 'pv-head', style: `background:${head}` }, h('div', { class: 'a' }, av ? h('img', { src: av, alt: '' }) : '💬'),
          h('div', {}, h('b', {}, g('title') || ' '), h('div', { style: 'font-size:12px;opacity:.9' }, '🟢 ' + (g('subtitle') || '')))),
          h('div', { class: 'pv-body' }, h('div', { class: 'pv-b' }, g('greeting')), h('div', { class: 'pv-v', style: `background:${c}` }, 'What are your prices?'), h('div', { class: 'pv-b' }, 'Our plans start at $19/month.'),
            h('div', { class: 'row', style: 'gap:6px;margin-top:4px' }, ...['Pricing', 'Talk to a human'].map(x => h('span', { style: `border:1.5px solid ${c};color:${c};border-radius:16px;padding:4px 11px;font-size:12px` }, x)))),
          g('showBranding') ? h('div', { style: 'text-align:center;font-size:11px;color:#9ca3af;padding:6px;background:inherit' }, '⚡ Powered by ' + (g('brandName') || 'Chatly')) : null),
        h('div', { style: `align-self:${right ? 'flex-end' : 'flex-start'}`, class: 'pv-launch' }, (() => { const i = icon('msg', 22); i.style.stroke = '#fff'; return i; })(), pill ? g('launcherLabel') : null));
      preview.lastChild.style.background = c;
    }
    const save = guard(async () => {
      await api('/settings', 'PUT', Object.fromEntries(KEYS.map(k => [k, g(k)]))); toast('Saved — reload your site to see the changes');
    });
    appendTo(page, h('div', { class: 'split' }, h('div', {},
      h('div', { class: 'card' }, h('h3', {}, 'Appearance'), h('div', { class: 'grid2' }, h('div', {}, ...inp('title', 'Title'), ...inp('color', 'Brand colour', 'color')), h('div', {}, ...inp('subtitle', 'Subtitle'), ...sel('position', 'Position', [['right', 'Bottom right'], ['left', 'Bottom left']]))),
        h('div', { class: 'grid2' }, h('div', {}, ...sel('launcherStyle', 'Launcher', [['circle', 'Round icon'], ['pill', 'Pill with label']])), h('div', {}, ...inp('launcherLabel', 'Launcher label'))),
        h('div', { class: 'grid2' }, h('div', {}, ...sel('theme', 'Theme', [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Match visitor system']])), h('div', {}, ...inp('avatarUrl', 'Avatar image URL', 'text', 'Shown in the header and next to replies'))),
        chk('gradient', 'Gradient header'), chk('showBranding', 'Show "Powered by" footer'), ...inp('brandName', 'Brand name (footer)')),
      h('div', { class: 'card' }, h('h3', {}, 'Messages'), ...txt('greeting', 'Welcome message'), ...txt('fallbackMessage', 'Bot fallback message'), ...txt('handoffMessage', 'Handoff message (agents online)'), ...txt('offlineMessage', 'Offline message (no agents online)')),
      h('div', { class: 'card' }, h('h3', {}, 'Behaviour'), chk('prechatForm', 'Ask for name and email before the first message (pre-chat form)'), chk('askEmail', 'Ask for email when handing over to a human'), chk('ratingEnabled', 'Ask for a satisfaction rating when a chat is closed'),
        chk('proactiveEnabled', 'Show proactive greeting bubble'), ...inp('proactiveDelay', 'Proactive delay (seconds)', 'number'), ...inp('proactiveMessage', 'Proactive message')),
      h('div', { class: 'card' }, h('h3', {}, 'Email'), h('div', { class: 'hint' }, S.mailConfigured ? '✓ SMTP is configured on the server.' : 'Set SMTP_URL (e.g. smtp://user:pass@smtp.example.com:587) and SMTP_FROM on the server to enable email.'),
        chk('emailNotifications', 'Email the team when a visitor needs a human and nobody is online'), chk('emailReplies', 'Email the visitor an agent reply when they have left the site'), chk('emailTranscript', 'Email the visitor a transcript when a chat is closed'),
        admin && S.mailConfigured ? h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('/mail/test', 'POST', {}); toast('Test email sent to ' + S.me.email); }) }, 'Send test email') : null),
      h('div', { class: 'card' }, h('h3', {}, 'Business hours & integrations'), chk('businessHoursEnabled', 'Only show as online during business hours'),
        h('div', { class: 'grid2' }, h('div', {}, ...inp('hoursStart', 'Opens (HH:MM)'), ...inp('hoursDays', 'Open days', 'text', '0 = Sunday … 6 = Saturday')), h('div', {}, ...inp('hoursEnd', 'Closes (HH:MM)'), ...inp('timezone', 'Timezone', 'text', 'e.g. America/New_York'))),
        ...inp('webhookUrl', 'Webhook URL', 'text', 'Receives JSON POSTs: conversation.created, message.created, visitor.identified, conversation.closed, conversation.rated'),
        ...inp('allowedOrigins', 'Allowed origins', 'text', 'Use * for any site, or a comma-separated list like https://shop.com')),
      admin ? h('button', { class: 'btn', style: 'padding:11px 22px', onclick: save }, 'Save changes') : h('div', { class: 'hint' }, 'Only admins can change settings.')), preview));
    drawPreview();
  } else if (settingsTab === 'sites') {
    const manage = can('sites.manage');
    const nm = h('input', { placeholder: 'Website name, e.g. Acme Store' }), dm = h('input', { placeholder: 'https://acme.com (optional)' });
    appendTo(page, ...S.sites.map(site => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', {}, site.name), h('div', { class: 'hint', style: 'margin:0' }, site.domain || 'No domain set')),
        manage ? [h('button', { class: 'btn sec sm', onclick: guard(async () => { const n = prompt('Website name', site.name); if (!n) return; const d = prompt('Domain (optional)', site.domain || '') ?? site.domain; await api('/sites/' + site.id, 'PUT', { name: n, domain: d }); await boot(); }) }, 'Rename'),
          h('button', { class: 'btn sec sm', title: 'Issue a new install key. The old snippet stops working immediately.', onclick: guard(async () => { if (!confirm('Rotate the install key? The current snippet will stop working until you replace it.')) return; await api(`/sites/${site.id}/rotate-key`, 'POST'); toast('New key issued'); await boot(); }) }, 'Rotate key'),
          S.sites.length > 1 ? h('button', { class: 'btn danger sm', onclick: guard(async () => { if (prompt(`This permanently deletes "${site.name}" with all its conversations and contacts. Type the website name to confirm.`) !== site.name) return; await api('/sites/' + site.id, 'DELETE'); S.site = 0; await boot(); }) }, 'Delete') : null] : null),
      installStatus(site),
      h('p', { class: 'hint' }, 'Paste this before </body> on every page of this website:'), h('pre', { class: 'code' }, snippet(site)),
      h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('button', { class: 'btn sec sm', onclick: () => { navigator.clipboard?.writeText(snippet(site)); toast('Copied'); } }, 'Copy snippet'),
        h('a', { class: 'btn sec sm', href: '/?key=' + encodeURIComponent(site.site_key), target: '_blank', style: 'text-decoration:none' }, 'Test widget ↗'),
        h('span', { class: 'hint', style: 'margin:0' }, 'Works on any site: WordPress, Shopify, Wix, Webflow, custom HTML. JS API: Chatly.open() / Chatly.close()')))),
      manage ? h('div', { class: 'card' }, h('h3', {}, 'Add a website'), h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Name'), nm), h('div', {}, h('label', {}, 'Domain'), dm)),
        h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { const r = await api('/sites', 'POST', { name: nm.value, domain: dm.value }); S.site = r.site.id; toast('Website added with its own chatbot, settings and install code'); await boot(); }) }, icon('plus', 16), 'Add website')) : null);
  } else if (settingsTab === 'canned') {
    const sc = h('input', { placeholder: 'shortcut, e.g. thanks' }), tx = h('textarea', { rows: 2, placeholder: 'Reply text' }), manage = can('canned.manage');
    appendTo(page, manage ? h('div', { class: 'card' }, h('h3', {}, 'Saved replies'), h('div', { class: 'hint' }, 'Shared by the whole workspace. In the inbox, type / and a shortcut to insert one.'), h('label', {}, 'Shortcut'), sc, h('label', {}, 'Text'), tx,
      h('button', { class: 'btn', style: 'margin-top:10px', onclick: guard(async () => { await api('/canned', 'POST', { shortcut: sc.value, text: tx.value }); S.canned = (await api('/canned')).canned; renderShell(); }) }, 'Add')) : null,
      h('div', { class: 'card' }, h('table', {}, h('tbody', {}, ...S.canned.map(c => h('tr', {}, h('td', {}, h('b', {}, '/' + c.shortcut)), h('td', {}, c.text),
        h('td', {}, manage ? h('button', { class: 'btn danger sm', onclick: guard(async () => { await api('/canned/' + c.id, 'DELETE'); S.canned = (await api('/canned')).canned; renderShell(); }) }, 'Delete') : null)))))));
  } else if (settingsTab === 'team') {
    const [{ members }, { roles }] = await Promise.all([api('/members'), api('/roles')]); S.members = members;
    const grantable = roles.filter(r => r.permissions.every(p => S.perms.has(p)));
    const roleSel = (val) => h('select', {}, ...grantable.map(r => h('option', { value: r.id, selected: r.id === val }, r.name)));
    const sitePick = (ids) => { const box = h('div', { class: 'sitepick' }), all = h('input', { type: 'checkbox', checked: !ids });
      const boxes = S.sites.map(x => h('input', { type: 'checkbox', value: x.id, checked: !ids || ids.includes(x.id), disabled: !ids }));
      all.onchange = () => boxes.forEach(b => { b.disabled = all.checked; b.checked = all.checked; });
      box.append(h('label', { class: 'inline' }, all, 'All websites (including future ones)'), ...S.sites.map((x, i) => h('label', { class: 'inline', style: 'margin-left:22px' }, boxes[i], x.name)));
      box.value = () => all.checked ? null : boxes.filter(b => b.checked).map(b => +b.value); return box; };
    const editMember = m => {
      const rs = roleSel(m.role_id), sp = sitePick(m.site_ids);
      const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:460px;max-width:96vw' }, h('h3', {}, 'Edit access — ' + m.name), h('label', {}, 'Role'), rs, S.sites.length > 1 ? [h('label', {}, 'Websites'), sp] : null,
        h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
          h('button', { class: 'btn', onclick: guard(async () => { await api('/members/' + m.id, 'PUT', { role_id: +rs.value, site_ids: sp.value() }); md.remove(); toast('Access updated — applies immediately'); renderShell(); }) }, 'Save'))));
      document.body.append(md);
    };
    const canTouch = m => m.id !== S.me.id && (roles.find(r => r.id === m.role_id)?.permissions || []).every(p => S.perms.has(p));
    const f = { name: h('input', { placeholder: 'Full name' }), email: h('input', { type: 'email', placeholder: 'name@company.com' }), password: h('input', { type: 'password', placeholder: 'Temporary password (min 8)' }) };
    const rs = roleSel(roles.find(r => r.name === 'Agent')?.id), sp = sitePick(null);
    appendTo(page, h('div', { class: 'card', style: 'padding:0' }, h('table', {}, h('thead', {}, h('tr', {}, ...['Teammate', 'Role', 'Websites', 'Status', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, ...members.map(m => h('tr', {}, h('td', {}, h('div', { class: 'row' }, avEl({ id: m.email, name: m.name }), h('div', {}, h('b', {}, m.name, m.id === S.me.id ? ' (you)' : ''), h('div', { class: 'hint', style: 'margin:0' }, m.email)))),
        h('td', {}, h('span', { class: 'pill' + (m.role === 'Owner' ? ' warn' : '') }, m.role)), h('td', {}, m.site_ids ? m.site_ids.map(id => S.sites.find(x => x.id === id)?.name).filter(Boolean).join(', ') : 'All'),
        h('td', {}, h('span', { class: 'pill ' + (m.online ? 'ok' : '') }, m.online ? 'online' : 'offline')),
        h('td', { style: 'text-align:right' }, canTouch(m) ? [h('button', { class: 'btn sec sm', onclick: () => editMember(m) }, 'Edit'), ' ',
          h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm(`Remove ${m.name} from ${S.workspace.name}?`)) { await api('/members/' + m.id, 'DELETE'); renderShell(); } }) }, 'Remove')] : null)))))),
      h('div', { class: 'card' }, h('h3', {}, 'Invite a teammate'), h('div', { class: 'hint' }, 'If they already have a Chatly account (in another workspace) just enter their email — no password needed.'),
        h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Name'), f.name, h('label', {}, 'Email'), f.email), h('div', {}, h('label', {}, 'Role'), rs, h('label', {}, 'Temporary password'), f.password)),
        S.sites.length > 1 ? [h('label', {}, 'Website access'), sp] : null,
        h('button', { class: 'btn', style: 'margin-top:14px', onclick: guard(async () => {
          const r = await api('/members', 'POST', { name: f.name.value, email: f.email.value, password: f.password.value, role_id: +rs.value, site_ids: sp.value() });
          toast(r.created ? 'Account created — share the email and temporary password with them' : 'Existing user added to this workspace'); renderShell();
        }) }, icon('plus', 16), 'Add teammate')));
  } else if (settingsTab === 'tickets') {
    await renderTicketSettings(page);
  } else if (settingsTab === 'departments') {
    await renderDepartments(page);
  } else if (settingsTab === 'roles') {
    const { roles } = await api('/roles');
    const groups = {}; for (const [k, d] of Object.entries(S.catalog)) (groups[k.split('.')[0]] ||= []).push([k, d]);
    const LABEL = { chats: 'Conversations', contacts: 'Contacts', canned: 'Saved replies', bot: 'Automation', settings: 'Settings', sites: 'Websites', team: 'Team', roles: 'Roles', analytics: 'Reports', audit: 'Security', workspace: 'Workspace' };
    const editor = r => {
      const nm = h('input', { value: r?.name || '', placeholder: 'e.g. Sales agent' }), boxes = {};
      const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:620px;max-width:96vw' }, h('h3', {}, r ? 'Edit role' : 'New role'), h('label', {}, 'Role name'), nm,
        h('label', {}, 'Permissions'), h('div', { class: 'permgrid' }, ...Object.entries(groups).map(([g, list]) => h('div', { class: 'permgroup' }, h('b', {}, LABEL[g] || g),
          ...list.map(([k, d]) => { const own = S.perms.has(k); boxes[k] = h('input', { type: 'checkbox', checked: r ? r.permissions.includes(k) : false, disabled: !own });
            return h('label', { class: 'inline', title: own ? k : "You don't have this permission, so you can't grant it" }, boxes[k], h('span', {}, d)); })))),
        h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
          h('button', { class: 'btn', onclick: guard(async () => { const body = { name: nm.value, permissions: Object.keys(boxes).filter(k => boxes[k].checked) };
            await (r ? api('/roles/' + r.id, 'PUT', body) : api('/roles', 'POST', body)); md.remove(); toast('Role saved — applies immediately'); renderShell(); }) }, 'Save role'))));
      document.body.append(md);
    };
    appendTo(page, h('div', { class: 'row', style: 'margin-bottom:14px' }, h('p', { class: 'hint grow', style: 'margin:0' }, 'Roles decide what each teammate can see and do. Changes apply instantly to everyone with that role. You can only grant permissions you have yourself.'),
      h('button', { class: 'btn', onclick: () => editor(null) }, icon('plus', 16), 'New role')),
      ...roles.map(r => h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', {}, r.name, ' ', r.system ? h('span', { class: 'pill warn' }, 'all permissions') : null),
        h('div', { class: 'hint', style: 'margin:0' }, `${r.members} member${r.members === 1 ? '' : 's'} · ${r.permissions.length} of ${Object.keys(S.catalog).length} permissions`)),
        !r.system && r.permissions.every(p => S.perms.has(p)) ? [h('button', { class: 'btn sec sm', onclick: () => editor(r) }, 'Edit'),
          h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm(`Delete role "${r.name}"?`)) { await api('/roles/' + r.id, 'DELETE'); renderShell(); } }) }, 'Delete')] : null),
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:5px;margin-top:10px' }, ...r.permissions.map(p => h('span', { class: 'tag', title: S.catalog[p] }, p))))));
  } else if (settingsTab === 'spam') {
    const [{ blocks, events, last24h }, { settings: st }] = await Promise.all([api('/spam'), api('/settings')]);
    const tv = h('select', { style: 'width:auto' }, ...[['keyword', 'Word or phrase'], ['ip', 'IP address'], ['email', 'Email'], ['visitor', 'Visitor ID']].map(([v, l]) => h('option', { value: v }, l)));
    const val = h('input', { placeholder: 'e.g. casino, 203.0.113.7' });
    const LBL = { keyword: 'Word', ip: 'IP', email: 'Email', visitor: 'Visitor' };
    appendTo(page, siteBar(),
      h('div', { class: 'grid' }, ...[['Blocked (24h)', last24h.blocked || 0, 'bad'], ['Flagged (24h)', last24h.flagged || 0, 'warn'], ['Reported by team (24h)', last24h.reported || 0, ''], ['Active blocks', blocks.length, '']]
        .map(([l, n, c]) => h('div', { class: 'stat ' + (c === 'bad' ? 'warn' : '') }, h('div', { class: 'ico' }, icon('shield')), h('div', {}, h('b', {}, n), h('span', {}, l))))),
      h('div', { class: 'card' }, h('h3', {}, 'Spam filter'), h('p', { class: 'hint' }, 'Messages are scored for links, scam phrases, spam campaigns seen across the platform, flooding and bots. High-risk messages are silently dropped (the spammer thinks it was sent); borderline ones reach your inbox marked “⚠ spam?”.'),
        h('div', { class: 'row' }, ...[['off', 'Off'], ['normal', 'Normal (recommended)'], ['strict', 'Strict']].map(([v, l]) => h('label', { class: 'inline', style: 'margin-right:18px' },
          h('input', { type: 'radio', name: 'sf', checked: (st.spamFilter || 'normal') === v, onchange: guard(async () => { await api('/settings', 'PUT', { spamFilter: v }); toast('Spam filter: ' + l); }) }), l)))),
      h('div', { class: 'card' }, h('h3', {}, 'Blocklist'), h('div', { class: 'row', style: 'margin:10px 0' }, tv, h('div', { class: 'grow' }, val),
        h('button', { class: 'btn', onclick: guard(async () => { await api('/spam/blocks', 'POST', { type: tv.value, value: val.value }); toast('Blocked'); renderShell(); }) }, 'Block')),
        blocks.length ? h('table', {}, h('tbody', {}, ...blocks.map(b => h('tr', {}, h('td', {}, h('span', { class: 'tag' }, LBL[b.type] || b.type)), h('td', {}, h('code', {}, b.value)), h('td', { class: 'hint' }, `${b.reason || ''} · ${b.created_by} · ${ago(b.created)} ago${b.expires ? ' · expires in ' + Math.max(1, Math.round((b.expires - Date.now()) / 3600000)) + 'h' : ''}`),
          h('td', { style: 'text-align:right' }, h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('/spam/blocks/' + b.id, 'DELETE'); renderShell(); }) }, 'Unblock'))))))
          : h('p', { class: 'hint' }, 'Nothing blocked yet. Block visitors from a conversation with the 🚫 button.')),
      h('div', { class: 'card' }, h('h3', {}, 'Recent spam activity'), events.length ? h('table', {}, h('thead', {}, h('tr', {}, ...['When', 'Result', 'Score', 'Message', 'Why'].map(x => h('th', {}, x)))),
        h('tbody', {}, ...events.map(e => h('tr', {}, h('td', { style: 'white-space:nowrap' }, ago(e.created) + ' ago'), h('td', {}, actionPill(e.action)), h('td', {}, e.score),
          h('td', { style: 'max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: e.summary }, e.summary), h('td', { class: 'hint' }, e.signals.map(x => x.detail).join('; '))))))
        : h('p', { class: 'hint' }, 'No spam detected yet 🎉')));
  } else if (settingsTab === 'notifications') {
    await renderNotificationPrefs(page, { siteBar, canManageSite: can('settings.manage') });
  } else if (settingsTab === 'modules') {
    const { modules } = await api('/modules');
    appendTo(page, h('p', { class: 'hint', style: 'margin:0 0 16px' }, `Turn features on or off for everyone in ${S.workspace.name}. Your plan: `, h('span', { class: 'tag' }, S.workspace.plan)),
      h('div', { class: 'modgrid' }, ...modules.map(m => h('div', { class: 'card modcard' + (m.enabled ? ' on' : '') },
        h('div', { class: 'row' }, h('b', { class: 'grow' }, m.name), m.core ? h('span', { class: 'pill' }, 'core') : !m.available ? h('span', { class: 'pill warn' }, 'not in plan')
          : h('label', { class: 'switch-t' }, h('input', { type: 'checkbox', checked: m.enabled, onchange: guard(async e => { try { const r = await api('/modules/' + m.key, 'PUT', { enabled: e.target.checked }); S.modules = r.modules; toast(`${m.name} ${e.target.checked ? 'on' : 'off'}`); renderShell(); } catch (x) { e.target.checked = !e.target.checked; throw x; } }) }), h('span', {}))),
        h('p', { class: 'hint', style: 'margin:8px 0 0' }, m.description), !m.available ? h('p', { class: 'hint', style: 'margin:6px 0 0' }, 'Upgrade your plan to use this module.') : null))));
  } else if (settingsTab === 'audit') {
    const { entries } = await api('/audit');
    appendTo(page, h('div', { class: 'card', style: 'padding:0' }, entries.length ? h('table', {}, h('thead', {}, h('tr', {}, ...['When', 'Who', 'Action', 'Details'].map(x => h('th', {}, x)))),
      h('tbody', {}, ...entries.map(e => h('tr', {}, h('td', { style: 'white-space:nowrap' }, new Date(e.created).toLocaleString()), h('td', {}, e.user_name), h('td', {}, h('span', { class: 'tag' }, e.action)), h('td', {}, e.detail || '')))))
      : h('div', { class: 'empty' }, 'No activity yet')));
  } else if (settingsTab === 'workspace') {
    const nm = h('input', { value: S.workspace.name, disabled: !can('workspace.manage') }), nw = h('input', { placeholder: 'e.g. My agency' });
    appendTo(page, h('div', { class: 'card', style: 'max-width:560px' }, h('h3', {}, 'This workspace'), h('label', {}, 'Name'), nm,
      can('workspace.manage') ? h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { await api('/workspace', 'PUT', { name: nm.value }); toast('Renamed'); await boot(); }) }, 'Save') : h('div', { class: 'hint' }, 'Only the workspace Owner can rename it.'),
      h('p', { class: 'hint', style: 'margin-top:14px' }, `You are ${S.role.name} here. ${S.sites.length} website${S.sites.length === 1 ? '' : 's'}, ${S.members.length} teammate${S.members.length === 1 ? '' : 's'}.`)),
      h('div', { class: 'card', style: 'max-width:560px' }, h('h3', {}, 'Create another workspace'), h('div', { class: 'hint' }, 'Separate business or client? Each workspace has its own websites, team, roles and data. Switch between them from the top of the sidebar.'),
        h('label', {}, 'Workspace name'), nw, h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { await api('/workspaces', 'POST', { name: nw.value }); S.site = 0; await boot(); toast('Workspace created'); }) }, 'Create workspace')));
  } else {
    await renderAccount(page);
  }
}

