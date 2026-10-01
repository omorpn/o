import { S, ago, api, avEl, can, guard, h, icon, toast, vname } from './core.js';
import { refreshNavBadge, renderShell } from './shell.js';

// ---------- inbox ----------
export async function loadConvs() {
  const p = new URLSearchParams();
  if (S.filter === 'closed') p.set('status', 'closed'); else { p.set('status', 'open'); if (S.filter !== 'open') p.set('filter', S.filter); }
  if (S.q) p.set('q', S.q);
  if (S.tag) p.set('tag', S.tag);
  const d = await api('/conversations?' + p);
  S.convs = new Map(d.conversations.map(c => [c.id, c]));
  drawList(); refreshNavBadge();
}
export function visibleConvs() {
  return [...S.convs.values()].filter(c => {
    if (S.tag && !(c.tags || []).includes(S.tag)) return false;
    if (S.filter === 'closed') return c.status === 'closed';
    if (c.status !== 'open') return false;
    if (S.filter === 'mine') return c.assignee_id === S.me.id;
    if (S.filter === 'unassigned') return !c.assignee_id;
    if (S.filter === 'human') return c.needs_human;
    return true;
  }).sort((a, b) => (b.needs_human - a.needs_human) || b.updated - a.updated);
}
export function renderInbox(main) {
  api('/tags').then(d => { const changed = JSON.stringify(d.tags) !== JSON.stringify(S.tags); S.tags = d.tags; if (changed && S.view === 'inbox' && !document.querySelector('.filters + .filters') && S.tags.length) renderShell(); }).catch(() => {});
  main.append(h('div', { class: 'inbox' },
    h('div', { class: 'list' },
      h('div', { class: 'top' },
        h('input', { placeholder: 'Search conversations…', value: S.q, oninput: debounce(e => { S.q = e.target.value; loadConvs(); }, 250) }),
        h('div', { class: 'filters' }, ...[['open', 'All open'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['human', 'Needs human'], ['closed', 'Closed']]
          .map(([k, l]) => h('button', { class: S.filter === k ? 'on' : '', onclick: () => { S.filter = k; renderShell(); } }, l))),
        S.tags.length ? h('div', { class: 'filters' }, h('span', { class: 'hint', style: 'margin:0 4px 0 0' }, 'Tags:'), ...S.tags.slice(0, 8).map(t => h('button', { class: S.tag === t.name ? 'on' : '', onclick: () => { S.tag = S.tag === t.name ? '' : t.name; renderShell(); } }, `${t.name} ${t.count}`))) : null),
      h('div', { class: 'items', id: 'items' })),
    h('div', { class: 'chat', id: 'chat' }), h('div', { class: 'side', id: 'side' })));
  loadConvs().then(() => { if (S.cur && S.convs.has(S.cur)) openConv(S.cur); else drawChatEmpty(); });
  drawSide();
}
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export function drawList() {
  const box = document.getElementById('items'); if (!box) return;
  const list = visibleConvs();
  box.replaceChildren(...(list.length ? list.map(c => h('div', { class: 'item' + (c.id === S.cur ? ' on' : '') + (c.unread ? ' unr' : ''), onclick: () => openConv(c.id) },
    avEl(c.visitor, c.visitor.online ? h('span', { class: 'on-dot' }) : null),
    h('div', { style: 'min-width:0;flex:1' },
      h('div', { class: 'nm' }, vname(c.visitor), c.spam ? h('span', { class: 'pill bad' }, 'spam') : c.spam_score >= 40 ? h('span', { class: 'pill warn', title: `Spam score ${c.spam_score}` }, '⚠ spam?') : null, c.needs_human ? h('span', { class: 'pill bad' }, 'human') : null, c.unread ? h('span', { class: 'unread' }, c.unread) : null, h('span', { class: 't' }, ago(c.updated))),
      h('div', { class: 'lb' }, c.last_body || '…'), S.sites.length > 1 && !S.site ? h('div', { class: 'hint', style: 'margin:1px 0 0;font-size:11.5px' }, '🌐 ' + (c.site_name || '')) : null,
      h('div', { class: 'row', style: 'gap:5px;margin-top:3px;flex-wrap:wrap' }, ...(c.tags || []).slice(0, 3).map(t => h('span', { class: 'tag' }, t)), c.assignee_name ? h('span', { class: 'hint', style: 'margin:0' }, '→ ' + c.assignee_name) : null)))) : [h('div', { class: 'empty' }, h('div', { class: 'big' }, '🎉'), 'No conversations here')]));
}
export function drawChatEmpty() { const c = document.getElementById('chat'); if (c) c.replaceChildren(h('div', { class: 'empty' }, h('div', { style: 'font-size:40px' }, '💬'), 'Select a conversation')); drawSide(); }
export async function openConv(id) {
  S.cur = id;
  const d = await api('/conversations/' + id);
  S.convs.set(id, d.conversation); S.msgs = d.messages;
  if (d.conversation.unread) { api(`/conversations/${id}/read`, 'POST').catch(() => {}); d.conversation.unread = 0; refreshNavBadge(); }
  const chat = document.getElementById('chat'); if (!chat) return;
  const ta = h('textarea', { placeholder: 'Type a message…  (type / for saved replies)' });
  const menu = h('div', { class: 'canned', style: 'display:none' });
  let sel = 0, opts = [];
  const closeMenu = () => { menu.style.display = 'none'; opts = []; };
  const drawMenu = () => menu.replaceChildren(...opts.map((c, i) => h('div', { class: i === sel ? 'on' : '', onmousedown: e => { e.preventDefault(); pick(c); } }, h('b', {}, '/' + c.shortcut), ' ' + c.text.slice(0, 80))));
  const pick = c => { ta.value = c.text; closeMenu(); ta.focus(); };
  ta.addEventListener('input', () => {
    const m = S.mode === 'reply' && ta.value.match(/^\/(\w*)$/);
    if (m) { opts = S.canned.filter(c => c.shortcut.startsWith(m[1].toLowerCase())); sel = 0; menu.style.display = opts.length ? 'block' : 'none'; drawMenu(); } else closeMenu();
    if (S.mode === 'reply' && Date.now() - (ta._t || 0) > 2500 && ta.value) { ta._t = Date.now(); api(`/conversations/${S.cur}/typing`, 'POST', {}).catch(() => {}); }
  });
  ta.addEventListener('keydown', e => {
    if (opts.length) {
      if (e.key === 'ArrowDown') { sel = (sel + 1) % opts.length; drawMenu(); return e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = (sel - 1 + opts.length) % opts.length; drawMenu(); return e.preventDefault(); }
      if (e.key === 'Enter' || e.key === 'Tab') { pick(opts[sel]); return e.preventDefault(); }
      if (e.key === 'Escape') return closeMenu();
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  const send = guard(async () => {
    const body = ta.value.trim(); if (!body) return;
    ta.value = '';
    await api(`/conversations/${S.cur}/${S.mode === 'note' ? 'note' : 'messages'}`, 'POST', { body });
  });
  const fileIn = h('input', { type: 'file', style: 'display:none', accept: 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain', onchange: guard(async () => {
    const f = fileIn.files[0]; fileIn.value = ''; if (!f) return;
    if (f.size > 3e6) throw new Error('File too large (max 3 MB)');
    const data = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(f); });
    await api(`/conversations/${S.cur}/upload`, 'POST', { name: f.name, type: f.type, data });
  }) });
  const modeBtn = (m, l, cls) => h('button', { class: (S.mode === m ? 'on ' : '') + cls, onclick: e => { S.mode = m; ta.placeholder = m === 'note' ? 'Internal note — only your team sees this' : 'Type a message…  (type / for saved replies)'; e.target.parentNode.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.target.classList.add('on'); } }, l);
  chat.replaceChildren(h('div', { class: 'hd', id: 'hd' }), h('div', { class: 'tagbar', id: 'tagbar' }), h('div', { class: 'msgs', id: 'msgs' }), h('div', { class: 'typing', id: 'typing' }),
    !can('chats.reply') ? h('div', { class: 'composer hint', style: 'text-align:center;padding:16px' }, '👁 Read-only — your role can view conversations but not reply.') : h('div', { class: 'composer' }, menu, h('div', { class: 'modes' }, modeBtn('reply', 'Reply', ''), modeBtn('note', 'Internal note', 'note')), ta,
      h('div', { class: 'row', style: 'margin-top:6px;justify-content:space-between' }, h('span', { class: 'row hint' }, fileIn, h('button', { class: 'btn sec sm', onclick: () => fileIn.click() }, icon('clip', 14), 'Attach'), h('button', { class: 'btn sec sm', onclick: e => toggleEmoji(e.currentTarget, ta) }, icon('smile', 14), 'Emoji'), ' Enter to send · Shift+Enter for newline'), h('button', { class: 'btn', onclick: send }, 'Send'))));
  drawHead(); drawTags(); drawMessages(); drawSide(); drawList(); ta.focus();
}
export function drawHead() {
  const hd = document.getElementById('hd'), c = S.convs.get(S.cur); if (!hd || !c) return;
  const assign = h('select', { disabled: !can('chats.assign'), title: can('chats.assign') ? 'Assign' : 'You cannot reassign chats', onchange: guard(async e => { await api(`/conversations/${c.id}/assign`, 'POST', { agent_id: e.target.value ? +e.target.value : null }); }) },
    h('option', { value: '' }, 'Unassigned'), ...S.members.filter(a => a.can_reply && (!a.site_ids || a.site_ids.includes(c.site_id)) || a.id === c.assignee_id).map(a => h('option', { value: a.id, selected: a.id === c.assignee_id }, a.name)));
  hd.replaceChildren(avEl(c.visitor), h('div', { class: 'grow', style: 'flex:1' }, h('b', {}, vname(c.visitor)),
    h('div', { class: 'hint' }, c.visitor.online ? '🟢 online' : 'offline', c.bot_active ? ' · 🤖 bot handling' : '')), assign,
    can('chats.close') ? h('button', { class: 'btn sec', onclick: guard(() => api(`/conversations/${c.id}/status`, 'POST', { status: c.status === 'open' ? 'closed' : 'open' })) }, c.status === 'open' ? '✓ Close' : 'Reopen') : null,
    can('chats.block') ? h('button', { class: 'btn sec', title: 'Block visitor or report spam', onclick: () => blockDialog(c) }, '🚫') : null,
    h('a', { class: 'btn sec', href: `/api/conversations/${c.id}/transcript`, title: 'Download transcript', style: 'text-decoration:none' }, icon('download')),
    can('chats.delete') ? h('button', { class: 'btn danger', title: 'Delete conversation', onclick: guard(async () => { if (confirm('Delete this conversation permanently?')) await api('/conversations/' + c.id, 'DELETE'); }) }, icon('trash')) : null);
}
export const EMOJI = [...'😀😃😄😁😆😅😂🤣😊😇🙂😉😍🥰😘😋😎🤩🥳🤔🙄😬😢😭😡👍👎👏🙌🙏💪👋🔥❤️💜🎉✨💯✅❌⭐🚀'.matchAll(/\p{Extended_Pictographic}\uFE0F?/gu)].map(m => m[0]);
export function toggleEmoji(btn, ta) {
  const old = document.querySelector('.emo'); if (old) return old.remove();
  const box = h('div', { class: 'emo' }, ...EMOJI.map(e => h('button', { onclick: () => { ta.value += e; ta.focus(); } }, e)));
  btn.closest('.composer').append(box);
}
export function blockDialog(c) {
  const ip = h('input', { type: 'checkbox' }), rep = h('input', { type: 'checkbox', checked: c.spam_score >= 40 }), why = h('input', { placeholder: 'Reason (optional)' });
  const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:440px;max-width:96vw' }, h('h3', {}, 'Block ' + vname(c.visitor)),
    h('p', { class: 'hint' }, 'Blocked visitors no longer see the chat widget on your websites. You can unblock them in Settings → Spam protection.'),
    c.spam_score ? h('div', { class: 'note warn' }, `Automatic spam score for this chat: ${c.spam_score}`) : null,
    h('label', { class: 'inline' }, rep, 'Report as spam (closes the chat and helps the platform catch spam campaigns)'), h('label', { class: 'inline' }, ip, 'Also block their IP address (affects everyone on that network)'),
    h('label', {}, 'Reason'), why,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
      h('button', { class: 'btn danger', onclick: guard(async () => { await api(`/conversations/${c.id}/block`, 'POST', { report: rep.checked, ip: ip.checked, reason: why.value }); md.remove(); toast('Visitor blocked'); }) }, 'Block visitor'))));
  document.body.append(md);
}
export function drawTags() {
  const bar = document.getElementById('tagbar'), c = S.convs.get(S.cur); if (!bar || !c) return;
  const save = guard(async tags => { await api(`/conversations/${c.id}/tags`, 'POST', { tags }); api('/tags').then(d => { S.tags = d.tags; }); });
  if (!can('chats.reply')) return bar.replaceChildren(h('span', { class: 'hint', style: 'margin:0' }, 'Tags'), ...(c.tags || []).map(t => h('span', { class: 'tag' }, t)));
  const inp = h('input', { placeholder: '+ add tag', list: 'taglist', onkeydown: e => { if (e.key === 'Enter' && inp.value.trim()) { save([...(c.tags || []), inp.value.trim()]); inp.value = ''; } } });
  bar.replaceChildren(h('span', { class: 'hint', style: 'margin:0' }, 'Tags'), ...(c.tags || []).map(t => h('span', { class: 'tag' }, t, h('button', { title: 'Remove', onclick: () => save(c.tags.filter(x => x !== t)) }, '×'))), inp,
    h('datalist', { id: 'taglist' }, ...S.tags.map(t => h('option', { value: t.name }))));
}
export function drawMessages() {
  const box = document.getElementById('msgs'); if (!box) return;
  const out = []; let prev = null, day = '';
  for (const m of S.msgs) {
    const d = new Date(m.created).toDateString(); if (d !== day) { day = d; out.push(h('div', { class: 'daysep' }, d === new Date().toDateString() ? 'Today' : d)); prev = null; }
    if (m.sender === 'system') { out.push(h('div', { class: 'sysmsg' }, m.body)); prev = null; continue; }
    const key = m.sender + (m.sender_name || '');
    if (key !== prev) out.push(h('div', { class: 'meta' + (m.sender === 'visitor' ? '' : ' r') }, (m.sender === 'visitor' ? vname(S.convs.get(S.cur)?.visitor) : m.sender_name || m.sender) + (m.sender === 'note' ? ' (note)' : '') + ' · ' + new Date(m.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    const att = m.attachment;
    out.push(h('div', { class: 'msg ' + m.sender }, att ? (/^image\//.test(att.type) ? h('a', { href: att.url, target: '_blank', rel: 'noopener' }, h('img', { src: att.url, alt: att.name, style: 'max-width:240px;border-radius:8px;display:block' })) : h('a', { href: att.url, target: '_blank', rel: 'noopener', style: 'color:inherit' }, '📎 ' + att.name)) : m.body)); prev = key;
  }
  box.replaceChildren(...out); box.scrollTop = box.scrollHeight; drawTyping();
}
export function drawTyping() {
  const t = document.getElementById('typing'), c = S.convs.get(S.cur); if (!t || !c) return;
  t.textContent = Date.now() - (S.typing[c.visitor.id] || 0) < 3000 ? vname(c.visitor) + ' is typing…' : '';
}
export function drawSide() {
  const side = document.getElementById('side'); if (!side) return;
  const c = S.convs.get(S.cur);
  if (!c) return side.replaceChildren(h('div', { class: 'empty' }, 'Visitor details appear here'));
  const v = c.visitor;
  const dl = (t, val) => val ? [h('dt', {}, t), h('dd', {}, val)] : [];
  side.replaceChildren(h('h4', {}, 'Visitor'), h('dl', {}, dl('Name', v.name), dl('Email', v.email && h('a', { href: 'mailto:' + v.email }, v.email)), dl('Status', v.online ? 'Online' : 'Offline'),
    dl('Current page', v.page), dl('Visits', String(v.visits)), dl('First seen', new Date(v.created).toLocaleString()), dl('Browser', v.ua?.slice(0, 90))),
    h('h4', {}, 'Conversation'), h('dl', {}, dl('Status', c.status), dl('Started', new Date(c.created).toLocaleString()), dl('Assignee', c.assignee_name || 'Unassigned'), dl('Handled by', c.bot_active ? 'Bot' : 'Human')));
}

// ---------- visitors ----------
