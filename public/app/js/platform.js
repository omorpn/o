import { S, ago, api, appendTo, avEl, guard, h, icon, toast } from './core.js';
import { debounce } from './inbox.js';
import { boot, renderShell } from './shell.js';

// ---------- platform console (super admins) ----------
export let platformTab = 'overview';
export async function renderPlatform(main) {
  const page = h('div', { class: 'page' }); main.append(page);
  const TABS = [['overview', 'Overview'], ['fraud', 'Fraud & abuse'], ['workspaces', 'Workspaces'], ['users', 'Users'], ['settings', 'Platform settings'], ['audit', 'Platform audit']];
  appendTo(page, h('h2', {}, '🛡 Platform console'), h('p', { class: 'hint', style: 'margin:-10px 0 16px' }, 'Every workspace on this Chatly server. Only platform admins can see this.'),
    h('div', { class: 'tabs' }, ...TABS.map(([k, l]) => h('button', { class: platformTab === k ? 'on' : '', onclick: () => { platformTab = k; renderShell(); } }, l))));
  const stat = (ic, n, l, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'ico' }, icon(ic)), h('div', {}, h('b', {}, n), h('span', {}, l)));
  const when = t => t ? new Date(t).toLocaleString() : '—';
  if (platformTab === 'overview') {
    const o = await api('/platform/overview'); const max = Math.max(1, ...o.signups.map(d => d.workspaces));
    appendTo(page, h('div', { class: 'grid' }, stat('home', o.workspaces, 'Workspaces'), stat('users', o.users, 'Users'), stat('eye', `${o.installed}/${o.sites}`, 'Websites with widget installed'),
      stat('zap', o.activeWorkspaces7d, 'Active workspaces (7 days)', 'ok'), stat('msg', o.conversationsToday, 'Conversations today'), stat('send', o.messagesToday, 'Messages today'),
      stat('eye', o.visitorsOnline, 'Visitors online now'), stat('users', o.agentsOnline, 'Agents online now'), stat('alert', o.suspended, 'Suspended workspaces', o.suspended ? 'warn' : '')),
      h('div', { class: 'card' }, h('h3', {}, 'New workspaces — last 14 days'),
        h('div', { style: 'display:flex;align-items:flex-end;gap:7px;height:110px;margin:14px 0 4px' }, ...o.signups.map(d => h('div', { title: `${d.date}: ${d.workspaces} workspaces, ${d.users} users`, style: `flex:1;background:linear-gradient(180deg,var(--pri2),var(--pri));border-radius:5px 5px 0 0;opacity:${d.workspaces ? 1 : .25};height:${Math.max(3, d.workspaces / max * 100)}%` }))),
        h('div', { class: 'row hint', style: 'justify-content:space-between' }, h('span', {}, o.signups[0].date), h('span', {}, o.signups[13].date))),
      h('div', { class: 'grid2' }, h('div', { class: 'card' }, h('h3', {}, 'Plans'), ...o.plans.map(pl => h('div', { class: 'check' }, h('b', { class: 'grow', style: 'flex:1' }, pl.plan), h('span', {}, pl.n)))),
        h('div', { class: 'card' }, h('h3', {}, 'Busiest workspaces (30 days)'), ...(o.top.length ? o.top.map(t => h('div', { class: 'check' }, h('b', { style: 'flex:1' }, t.name), h('span', {}, t.conversations + ' chats'))) : [h('p', { class: 'hint' }, 'No conversations yet')]))),
      h('div', { class: 'card' }, h('h3', {}, 'Server'), h('p', { class: 'hint' }, `Email (SMTP): ${o.mail ? '✅ configured' : '— not configured'} · AI answers: ${o.ai ? '✅ configured' : '— not configured'}`)));
  } else if (platformTab === 'workspaces') {
    const { settings } = await api('/platform/settings'); const plans = settings.plans.split(',');
    const box = h('div', { class: 'card', style: 'padding:0' }); let q = '', filter = '';
    const load = guard(async () => {
      const { workspaces } = await api(`/platform/workspaces?q=${encodeURIComponent(q)}&filter=${filter}`);
      box.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ...['Workspace', 'Owner', 'Plan', 'Websites', 'Team', 'Chats', 'Last activity', 'Status'].map(x => h('th', {}, x)))),
        h('tbody', {}, ...workspaces.map(w => h('tr', { style: 'cursor:pointer', onclick: () => openWorkspace(w.id, plans, load) }, h('td', {}, h('b', {}, w.name), h('div', { class: 'hint', style: 'margin:0' }, '#' + w.id + ' · ' + new Date(w.created).toLocaleDateString())),
          h('td', {}, w.owner?.email || '—'), h('td', {}, h('span', { class: 'tag' }, w.plan)), h('td', {}, w.sites), h('td', {}, w.members), h('td', {}, w.conversations), h('td', {}, w.last_activity ? ago(w.last_activity) + ' ago' : '—'),
          h('td', {}, w.suspended ? h('span', { class: 'pill bad' }, 'suspended') : w.agents_online ? h('span', { class: 'pill ok' }, 'online') : h('span', { class: 'pill' }, 'active')))))));
    });
    appendTo(page, h('div', { class: 'row', style: 'margin-bottom:14px' }, h('input', { placeholder: 'Search name, owner email or domain…', style: 'max-width:340px', oninput: debounce(e => { q = e.target.value; load(); }, 250) }),
      h('select', { style: 'width:auto', onchange: e => { filter = e.target.value; load(); } }, h('option', { value: '' }, 'All workspaces'), h('option', { value: 'suspended' }, 'Suspended'), ...plans.map(pl => h('option', { value: 'plan:' + pl }, 'Plan: ' + pl)))), box);
    load();
  } else if (platformTab === 'users') {
    const box = h('div', { class: 'card', style: 'padding:0' }); let q = '';
    const load = guard(async () => {
      const { users } = await api('/platform/users?q=' + encodeURIComponent(q));
      box.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ...['User', 'Workspaces', 'Joined', 'Last sign-in', 'Status', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, ...users.map(u => h('tr', {}, h('td', {}, h('div', { class: 'row' }, avEl({ id: u.email, name: u.name }), h('div', {}, h('b', {}, u.name, u.platform_role ? ' 🛡' : ''), h('div', { class: 'hint', style: 'margin:0' }, u.email)))),
          h('td', {}, u.memberships.map(m => `${m.name} (${m.role})`).join(', ') || '—'), h('td', {}, new Date(u.created).toLocaleDateString()), h('td', {}, u.last_login ? ago(u.last_login) + ' ago' : 'never'),
          h('td', {}, u.disabled ? h('span', { class: 'pill bad' }, 'disabled') : u.online ? h('span', { class: 'pill ok' }, 'online') : h('span', { class: 'pill' }, 'active')),
          h('td', { style: 'text-align:right;white-space:nowrap' }, u.id === S.me.id ? h('span', { class: 'hint' }, 'you') : [
            h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('/platform/users/' + u.id, 'PUT', { disabled: !u.disabled }); toast(u.disabled ? 'Account enabled' : 'Account disabled and signed out'); load(); }) }, u.disabled ? 'Enable' : 'Disable'), ' ',
            h('button', { class: 'btn sec sm', onclick: guard(async () => { if (!confirm(`Reset ${u.email}'s password? They will be signed out.`)) return; const r = await api(`/platform/users/${u.id}/reset-password`, 'POST'); r.emailed ? toast('Temporary password emailed') : prompt('Temporary password (share it securely):', r.temporaryPassword); }) }, 'Reset password'), ' ',
            h('button', { class: 'btn sec sm', onclick: guard(async () => { if (!confirm(u.platform_role ? `Remove platform admin from ${u.email}?` : `Make ${u.email} a platform admin? They will see every workspace.`)) return; await api('/platform/users/' + u.id, 'PUT', { platform_role: u.platform_role ? null : 'superadmin' }); load(); }) }, u.platform_role ? 'Revoke admin' : 'Make admin')]))))));
    });
    appendTo(page, h('input', { placeholder: 'Search name or email…', style: 'max-width:340px;margin-bottom:14px', oninput: debounce(e => { q = e.target.value; load(); }, 250) }), box); load();
  } else if (platformTab === 'settings') {
    const { settings: st, signupForcedOff } = await api('/platform/settings');
    const su = h('input', { type: 'checkbox', checked: st.allowSignup, disabled: signupForcedOff }), an = h('input', { value: st.announcement, placeholder: 'Shown at the top of every dashboard, e.g. planned maintenance' }), pl = h('input', { value: st.plans });
    appendTo(page, h('div', { class: 'card', style: 'max-width:640px' }, h('label', { class: 'inline' }, su, 'Allow new businesses to sign up'), signupForcedOff ? h('div', { class: 'hint' }, 'Forced off by the ALLOW_SIGNUP=0 environment variable.') : null,
      h('label', {}, 'Announcement banner'), an, h('label', {}, 'Plans (comma separated)'), pl, h('div', { class: 'hint' }, 'Labels you can assign to workspaces. Billing is not connected yet.'),
      h('button', { class: 'btn', style: 'margin-top:14px', onclick: guard(async () => { await api('/platform/settings', 'PUT', { allowSignup: su.checked, announcement: an.value, plans: pl.value }); toast('Saved'); await boot(); }) }, 'Save')));
  } else if (platformTab === 'audit') {
    const { entries } = await api('/platform/audit');
    appendTo(page, h('div', { class: 'card', style: 'padding:0' }, entries.length ? h('table', {}, h('thead', {}, h('tr', {}, ...['When', 'Admin', 'Action', 'Details'].map(x => h('th', {}, x)))),
      h('tbody', {}, ...entries.map(e => h('tr', {}, h('td', { style: 'white-space:nowrap' }, when(e.created)), h('td', {}, e.user_name), h('td', {}, h('span', { class: 'tag' }, e.action)), h('td', {}, e.detail || '')))))
      : h('div', { class: 'empty' }, 'No platform actions yet')));
  } else if (platformTab === 'fraud') await renderFraud(page);
}
export const actionPill = a => h('span', { class: 'pill ' + ({ blocked: 'bad', reported: 'bad', flagged: 'warn', would_block: 'warn' }[a] || '') }, { would_block: 'would block', reported: 'reported' }[a] || a);
export const KIND = { signup: 'Sign-up', login: 'Sign-in', visitor_message: 'Visitor message', agent_message: 'Agent message', workspace: 'Workspace' };
export async function renderFraud(page) {
  const ov = await api('/platform/fraud/overview'); const st = ov.settings;
  const cnt = (kind, action) => ov.byKind.filter(r => (!kind || r.kind === kind) && (!action || r.action === action)).reduce((a, r) => a + r.n, 0);
  const stat = (ic, n, l, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'ico' }, icon(ic)), h('div', {}, h('b', {}, n), h('span', {}, l)));
  appendTo(page, h('div', { class: 'grid' }, stat('alert', ov.open, 'Waiting for review', ov.open ? 'warn' : ''), stat('shield', ov.blocked24h, 'Blocked in 24h'), stat('users', cnt('signup'), 'Risky sign-ups (24h)'),
    stat('clock', cnt('login'), 'Sign-in attacks (24h)'), stat('msg', cnt('visitor_message'), 'Spam messages (24h)'), stat('send', cnt('agent_message'), 'Phishing attempts (24h)'), stat('users', ov.lockedAccounts, 'Accounts locked now'), stat('shield', ov.blocklist, 'Platform blocklist')),
    st.fraudMode === 'monitor' ? h('div', { class: 'note warn' }, '👁 Monitor mode: risky actions are logged but nothing is blocked. Switch to Enforce below.') : null);
  // review queue
  const queue = h('div'); let qStatus = 'open', qKind = '';
  const loadQueue = guard(async () => {
    const { events } = await api(`/platform/fraud/events?status=${qStatus}${qKind ? '&kind=' + qKind : ''}`);
    queue.replaceChildren(...(events.length ? events.map(e => {
      const acts = { block_ip: e.ip && h('input', { type: 'checkbox' }), block_email: (e.email || e.user_email) && e.kind !== 'visitor_message' && h('input', { type: 'checkbox' }), block_domain: (e.email || e.user_email) && e.kind === 'signup' && h('input', { type: 'checkbox' }),
        block_visitor: e.visitor_id && h('input', { type: 'checkbox', checked: true }), disable_user: e.user_id && h('input', { type: 'checkbox', checked: e.kind === 'signup' }), suspend_workspace: e.workspace_id && e.kind !== 'visitor_message' && h('input', { type: 'checkbox' }) };
      const LB = { block_ip: `Block IP ${e.ip}`, block_email: 'Block email', block_domain: `Block domain ${(e.email || e.user_email || '').split('@')[1]}`, block_visitor: 'Block visitor everywhere', disable_user: `Disable ${e.user_email || 'user'}`, suspend_workspace: `Suspend ${e.workspace_name || 'workspace'}` };
      const decide = d => guard(async () => { const actions = Object.fromEntries(Object.entries(acts).filter(([, el]) => el).map(([k, el]) => [k, el.checked])); const r = await api('/platform/fraud/events/' + e.id, 'POST', { decision: d, actions }); toast(d === 'confirm' ? 'Confirmed' + (r.done.length ? ': ' + r.done.join(', ') : '') : 'Dismissed'); loadQueue(); });
      return h('div', { class: 'card fraud' + (e.score >= st.blockThreshold ? ' high' : '') }, h('div', { class: 'row' }, h('div', { class: 'score' }, e.score), h('div', { class: 'grow' },
        h('b', {}, KIND[e.kind] || e.kind), ' ', actionPill(e.action), e.status !== 'open' ? h('span', { class: 'pill' }, e.status) : null,
        h('div', { class: 'hint', style: 'margin:2px 0 0' }, [new Date(e.created).toLocaleString(), e.workspace_name && '🏢 ' + e.workspace_name, (e.user_email || e.email) && '✉ ' + (e.user_email || e.email), e.ip && '🌐 ' + e.ip].filter(Boolean).join(' · '))),
      ), e.summary ? h('div', { class: 'quote' }, e.summary) : null,
        h('ul', { class: 'signals' }, ...e.signals.map(x => h('li', {}, h('b', {}, '+' + x.weight), ' ', x.detail, h('span', { class: 'hint' }, ' ' + x.code)))),
        e.status === 'open' ? h('div', { class: 'row', style: 'flex-wrap:wrap;gap:14px;margin-top:10px' }, ...Object.entries(acts).filter(([, el]) => el).map(([k, el]) => h('label', { class: 'inline', style: 'margin:0' }, el, LB[k])),
          h('span', { class: 'grow' }), h('button', { class: 'btn sec sm', onclick: decide('dismiss') }, 'Dismiss (not fraud)'), h('button', { class: 'btn danger sm', onclick: decide('confirm') }, 'Confirm fraud & apply')) : h('div', { class: 'hint' }, `Reviewed by ${e.reviewed_by || '—'}`));
    }) : [h('div', { class: 'card empty' }, h('div', { class: 'big' }, '✅'), qStatus === 'open' ? 'Nothing waiting for review' : 'No events')]));
  });
  appendTo(page, h('div', { class: 'row', style: 'margin:8px 0 12px' }, h('h3', { class: 'grow', style: 'margin:0' }, 'Review queue'),
    h('select', { style: 'width:auto', onchange: e => { qKind = e.target.value; loadQueue(); } }, h('option', { value: '' }, 'All types'), ...Object.entries(KIND).map(([k, l]) => h('option', { value: k }, l))),
    h('select', { style: 'width:auto', onchange: e => { qStatus = e.target.value; loadQueue(); } }, ...[['open', 'Open'], ['confirmed', 'Confirmed'], ['dismissed', 'Dismissed'], ['all', 'All']].map(([v, l]) => h('option', { value: v }, l)))), queue);
  loadQueue();
  // risky workspaces
  appendTo(page, h('div', { class: 'card', style: 'margin-top:18px' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Riskiest workspaces'), h('button', { class: 'btn sec sm', onclick: guard(async () => { const r = await api('/platform/fraud/rescan', 'POST'); toast(`Re-scored ${r.scanned} workspaces`); renderShell(); }) }, 'Re-scan')),
    ov.risky.length ? h('table', {}, h('thead', {}, h('tr', {}, ...['Workspace', 'Owner', 'Risk', 'Plan', 'Status'].map(x => h('th', {}, x)))), h('tbody', {}, ...ov.risky.map(w => h('tr', { style: 'cursor:pointer', onclick: async () => openWorkspace(w.id, (await api('/platform/settings')).settings.plans.split(','), () => renderShell()) },
      h('td', {}, h('b', {}, w.name)), h('td', {}, w.owner?.email || '—'), h('td', {}, h('div', { class: 'riskbar' }, h('div', { style: `width:${Math.min(100, w.risk_score / st.autoSuspendThreshold * 100)}%` })), ' ', w.risk_score), h('td', {}, w.plan), h('td', {}, w.suspended ? h('span', { class: 'pill bad' }, 'suspended') : 'active')))))
      : h('p', { class: 'hint' }, 'No risky workspaces 🎉')));
  // blocklist
  const { blocks } = await api('/platform/fraud/blocklist');
  const bt = h('select', { style: 'width:auto' }, ...[['ip', 'IP address'], ['email', 'Email'], ['email_domain', 'Email domain'], ['keyword', 'Spam word (all sites)'], ['visitor', 'Visitor ID']].map(([v, l]) => h('option', { value: v }, l)));
  const bv = h('input', { placeholder: 'value' }), bh = h('input', { type: 'number', placeholder: 'hours (empty = forever)', style: 'width:190px' }), ue = h('input', { placeholder: 'email of a locked account' });
  appendTo(page, h('div', { class: 'card' }, h('h3', {}, 'Platform blocklist'), h('p', { class: 'hint' }, 'Applies to every workspace: sign-ups, sign-ins and chat widgets.'),
    h('div', { class: 'row', style: 'margin:10px 0' }, bt, h('div', { class: 'grow' }, bv), bh, h('button', { class: 'btn', onclick: guard(async () => { await api('/platform/fraud/blocklist', 'POST', { type: bt.value, value: bv.value, hours: bh.value ? +bh.value : null }); toast('Added'); renderShell(); }) }, 'Add')),
    blocks.length ? h('table', {}, h('tbody', {}, ...blocks.map(b => h('tr', {}, h('td', {}, h('span', { class: 'tag' }, b.type)), h('td', {}, h('code', {}, b.value)), h('td', { class: 'hint' }, `${b.reason || ''} · ${b.created_by} · ${new Date(b.created).toLocaleDateString()}${b.expires ? ' · until ' + new Date(b.expires).toLocaleString() : ''}`),
      h('td', { style: 'text-align:right' }, h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('/platform/fraud/blocklist/' + b.id, 'DELETE'); renderShell(); }) }, 'Remove')))))) : h('p', { class: 'hint' }, 'Empty'),
    h('div', { class: 'row', style: 'margin-top:14px' }, h('div', { class: 'grow' }, ue), h('button', { class: 'btn sec', onclick: guard(async () => { await api('/platform/fraud/unlock', 'POST', { email: ue.value }); toast('Account unlocked'); }) }, 'Unlock account'))));
  // settings
  const mode = h('select', {}, h('option', { value: 'enforce', selected: st.fraudMode === 'enforce' }, 'Enforce — block high-risk actions'), h('option', { value: 'monitor', selected: st.fraudMode === 'monitor' }, 'Monitor — log only, never block'));
  const rt = h('input', { type: 'number', value: st.reviewThreshold }), btr = h('input', { type: 'number', value: st.blockThreshold }), as = h('input', { type: 'checkbox', checked: st.autoSuspend }), ast = h('input', { type: 'number', value: st.autoSuspendThreshold });
  appendTo(page, h('div', { class: 'card', style: 'max-width:680px' }, h('h3', {}, 'Detection settings'), h('label', {}, 'Mode'), mode,
    h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Review threshold'), rt, h('div', { class: 'hint' }, 'Score at which an action goes to the review queue')), h('div', {}, h('label', {}, 'Block threshold'), btr, h('div', { class: 'hint' }, 'Score at which an action is blocked'))),
    h('label', { class: 'inline', style: 'margin-top:14px' }, as, 'Automatically suspend workspaces whose 7-day risk exceeds'), ast,
    h('button', { class: 'btn', style: 'margin-top:14px', onclick: guard(async () => { await api('/platform/fraud/settings', 'PUT', { fraudMode: mode.value, reviewThreshold: +rt.value, blockThreshold: +btr.value, autoSuspend: as.checked, autoSuspendThreshold: +ast.value }); toast('Saved'); renderShell(); }) }, 'Save settings')));
}
export const openWorkspace = guard(async (id, plans, reload) => {
  const { workspace: w, members, sites, audit: log } = await api('/platform/workspaces/' + id);
  const d = h('div', { class: 'drawer' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', { style: 'margin:0' }, w.name), h('div', { class: 'hint', style: 'margin:0' }, `#${w.id} · created ${new Date(w.created).toLocaleDateString()} · owner ${w.owner?.email || '—'}`)), h('button', { class: 'btn sec sm', onclick: () => d.remove() }, '✕')),
    w.suspended ? h('div', { class: 'note bad' }, '⛔ Suspended: ' + w.suspended_reason) : null,
    h('label', {}, 'Plan'), h('select', { onchange: guard(async e => { await api('/platform/workspaces/' + id, 'PUT', { plan: e.target.value }); toast('Plan updated'); reload(); }) }, ...plans.map(pl => h('option', { value: pl, selected: pl === w.plan }, pl))),
    h('div', { class: 'row', style: 'margin-top:14px;flex-wrap:wrap' },
      w.suspended ? h('button', { class: 'btn', onclick: guard(async () => { await api('/platform/workspaces/' + id, 'PUT', { suspended: false }); toast('Reactivated'); d.remove(); reload(); }) }, 'Reactivate')
        : h('button', { class: 'btn danger', onclick: guard(async () => { const reason = prompt('Reason shown to the workspace (e.g. unpaid invoice, abuse):'); if (reason == null) return; await api('/platform/workspaces/' + id, 'PUT', { suspended: true, reason }); toast('Suspended — dashboard, widget and live chats are blocked'); d.remove(); reload(); }) }, 'Suspend'),
      h('button', { class: 'btn danger', onclick: guard(async () => { const c = prompt(`Permanently delete "${w.name}" and ALL its data? Type the workspace name to confirm.`); if (c == null) return; await api('/platform/workspaces/' + id, 'DELETE', { confirm: c }); toast('Workspace deleted'); d.remove(); reload(); }) }, 'Delete…')),
    h('h4', { class: 'dh' }, `Websites (${sites.length})`), ...sites.map(s => h('div', { class: 'check' }, h('div', { style: 'flex:1' }, h('b', {}, s.name), h('div', { class: 'hint', style: 'margin:0' }, (s.domain || 'no domain') + ' · ' + (s.last_seen_at ? `widget seen ${ago(s.last_seen_at)} ago on ${s.last_origin}` : 'widget not detected'))), h('span', {}, s.conversations + ' chats'))),
    h('h4', { class: 'dh' }, `Team (${members.length})`), ...members.map(u => h('div', { class: 'check' }, avEl({ id: u.email, name: u.name }), h('div', { style: 'flex:1' }, h('b', {}, u.name, u.disabled ? ' (disabled)' : ''), h('div', { class: 'hint', style: 'margin:0' }, u.email)), h('span', { class: 'tag' }, u.role))),
    h('h4', { class: 'dh' }, 'Recent activity'), ...(log.length ? log.map(e => h('div', { class: 'hint', style: 'margin:6px 0' }, `${new Date(e.created).toLocaleString()} · ${e.user_name} · ${e.action}${e.detail ? ' · ' + e.detail : ''}`)) : [h('p', { class: 'hint' }, 'Nothing yet')]));
  document.querySelector('.drawer')?.remove(); document.body.append(d);
});

