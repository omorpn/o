import { S, ago, api, appendTo, avEl, can, cfgSite, h, icon } from './core.js';
import { renderShell } from './shell.js';

// ---------- overview ----------
export async function renderDashboard(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const safe = p => api(p).catch(() => null);
  const [s, an, kb] = await Promise.all([api('/stats'), can('analytics.view') ? safe('/analytics') : null, safe('/kb')]);
  const stat = (ic, n, l, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'ico' }, icon(ic)), h('div', {}, h('b', {}, n), h('span', {}, l)));
  const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const steps = can('settings.manage') ? [
    ['Install the widget on your website', 'Settings → Websites has the snippet for each site', s.today + s.open + s.resolved + s.visitorsOnline > 0],
    ['Receive your first conversation', 'Open your site (or the demo page) and say hello', s.open + s.resolved > 0],
    ['Teach the bot with your FAQ', 'Chatbot & flows → Knowledge base', (kb?.kb.length || 0) > 2],
    ['Invite a teammate', 'Settings → Team', S.members.length > 1],
    ['Add another website', 'Settings → Websites', S.sites.length > 1],
  ] : [];
  const done = steps.filter(x => x[2]).length;
  const siteName = S.site ? S.sites.find(x => x.id === S.site)?.name : S.sites.length > 1 ? 'all websites' : S.sites[0]?.name;
  appendTo(page, h('h2', {}, `${greet}, ${S.me.name.split(' ')[0]} 👋`), h('p', { class: 'hint', style: 'margin:-10px 0 18px' }, `${S.workspace.name} · ${siteName} · you are ${S.role.name}`),
    h('div', { class: 'grid' }, stat('msg', s.open, 'Open conversations'), stat('alert', s.needsHuman, 'Waiting for a human', s.needsHuman ? 'warn' : ''), stat('inbox', s.unassigned, 'Unassigned'), stat('eye', s.visitorsOnline, 'Visitors online'),
      stat('zap', s.today, 'New chats today'), stat('send', s.messagesToday, 'Messages today'), stat('check', s.resolved, 'Resolved total', 'ok'), stat('users', s.agentsOnline, 'Teammates online')),
    steps.length && done < steps.length ? h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Getting started'), h('span', { class: 'hint' }, `${done} of ${steps.length} done`)),
      h('div', { class: 'progress' }, h('div', { style: `width:${done / steps.length * 100}%` })),
      ...steps.map(([t, d, ok]) => h('div', { class: 'check' + (ok ? ' done' : '') }, h('div', { class: 'c' }, ok ? icon('check', 14) : null), h('div', {}, h('b', {}, t), h('div', { class: 'hint', style: 'margin:0' }, d))))) : null,
    an ? (() => { const max = Math.max(1, ...an.days.map(d => d.chats)); return h('div', { class: 'card' }, h('h3', {}, 'Conversations — last 14 days'),
      h('div', { style: 'display:flex;align-items:flex-end;gap:7px;height:130px;margin:16px 0 4px' }, ...an.days.map(d => h('div', { title: `${d.date}: ${d.chats} chats, ${d.messages} messages`, style: `flex:1;background:linear-gradient(180deg,var(--pri2),var(--pri));border-radius:5px 5px 0 0;opacity:${d.chats ? 1 : .25};height:${Math.max(3, d.chats / max * 100)}%` }))),
      h('div', { class: 'row hint', style: 'justify-content:space-between' }, h('span', {}, an.days[0].date), h('span', {}, an.days[13].date)),
      h('div', { class: 'grid', style: 'margin:16px 0 0' }, stat('clock', an.avgFirstResponseSec == null ? '—' : an.avgFirstResponseSec < 90 ? an.avgFirstResponseSec + 's' : Math.round(an.avgFirstResponseSec / 60) + 'm', 'Avg first response'),
        stat('star', an.csat == null ? '—' : an.csat + ' / 5', `Satisfaction (${an.ratings} ratings)`), stat('bot', an.botHandledPct + '%', 'Handled by bot only'), stat('users', an.contacts, 'Contacts with email')),
      an.agents.length ? [h('h3', { style: 'margin-top:18px' }, 'Team performance'), h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Teammate'), h('th', {}, 'Chats handled'), h('th', {}, 'Satisfaction'))),
        h('tbody', {}, ...an.agents.map(a => h('tr', {}, h('td', {}, h('div', { class: 'row' }, avEl({ id: a.name, name: a.name }), a.name)), h('td', {}, a.chats), h('td', {}, a.csat == null ? '—' : a.csat + ' / 5')))))] : null); })() : null);
}
export const snippet = (site = S.sites.find(x => x.id === cfgSite())) => `<script src="${location.origin}/widget.js?key=${site?.site_key}" data-key="${site?.site_key}" async></script>`;
export const installStatus = site => site.last_error ? h('div', { class: 'note bad' }, '⚠️ ', site.last_error, ` (${ago(site.last_error_at) === 'now' ? 'just now' : ago(site.last_error_at) + ' ago'})`)
  : site.last_seen_at ? h('div', { class: 'note ok' }, `✅ Widget detected on ${site.last_origin || 'your site'} · last seen ${ago(site.last_seen_at) === 'now' ? 'just now' : ago(site.last_seen_at) + ' ago'}`)
  : h('div', { class: 'note warn' }, '⏳ Not detected yet. Paste the snippet into your site, open a page, then refresh this screen. Use “Test widget” to check it works here first.');
/** Website picker shown on pages that configure a single site. */
export const siteBar = () => S.sites.length > 1 ? h('div', { class: 'row', style: 'margin:-6px 0 18px' }, h('span', { class: 'hint', style: 'margin:0' }, 'Website:'),
  h('select', { style: 'width:auto', onchange: e => { S.site = +e.target.value; renderShell(); } }, ...S.sites.map(x => h('option', { value: x.id, selected: x.id === cfgSite() }, x.name)))) : null;

