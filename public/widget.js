/* Chatly embeddable chat widget. Usage:
   <script src="https://YOUR-HOST/widget.js" data-key="SITE_KEY" async></script> */
(function () {
  if (window.__chatly) return; window.__chatly = true;
  var script = document.currentScript || document.querySelector('script[data-key][src*="widget.js"]');
  var KEY = script && script.getAttribute('data-key');
  if (!KEY) return console.warn('[Chatly] missing data-key');
  var BASE = new URL(script.src).origin;
  var store = function (k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} };
  var VID = store('chatly_vid');
  if (!VID) { VID = 'v' + Array.from(crypto.getRandomValues(new Uint8Array(12))).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''); store('chatly_vid', VID); }

  var state = { settings: null, messages: [], open: false, unread: 0, agentsOnline: false, needEmail: false, typing: null, ids: {} };
  var es, typingTimer, lastTypingSent = 0;

  function api(path, body) {
    return fetch(BASE + '/api/widget/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ key: KEY, vid: VID }, body)) }).then(function (r) { return r.json(); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  var host = el('div'); host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;bottom:0;' ;
  var root = host.attachShadow({ mode: 'open' });
  var css = el('style'); css.textContent = [
    ':host{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}*{box-sizing:border-box}',
    '.wrap{position:fixed;bottom:20px;display:flex;flex-direction:column;align-items:flex-end;gap:12px}',
    '.wrap.left{left:20px;align-items:flex-start}.wrap.right{right:20px}',
    '.launcher{width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:var(--c);color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;position:relative;transition:transform .15s}',
    '.launcher:hover{transform:scale(1.06)}.launcher svg{width:28px;height:28px;fill:#fff}',
    '.badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#ef4444;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px}',
    '.teaser{background:#fff;color:#111827;padding:12px 16px;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.18);max-width:260px;font-size:14px;cursor:pointer;line-height:1.4}',
    '.panel{width:370px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 110px);background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;animation:pop .18s ease-out}',
    '@keyframes pop{from{opacity:0;transform:translateY(12px) scale(.97)}}',
    '.head{background:var(--c);color:#fff;padding:16px 18px;display:flex;align-items:center;gap:12px}',
    '.head .t{font-weight:700;font-size:16px}.head .s{font-size:12px;opacity:.9;margin-top:2px;display:flex;align-items:center;gap:6px}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#9ca3af}.dot.on{background:#4ade80}',
    '.head .x{margin-left:auto;background:rgba(255,255,255,.18);border:0;color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:18px;line-height:1}',
    '.msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;background:#f9fafb}',
    '.m{max-width:80%;padding:9px 13px;border-radius:16px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}',
    '.m.visitor{align-self:flex-end;background:var(--c);color:#fff;border-bottom-right-radius:4px}',
    '.m.agent,.m.bot{align-self:flex-start;background:#fff;color:#111827;border:1px solid #e5e7eb;border-bottom-left-radius:4px}',
    '.who{font-size:11px;color:#6b7280;margin:4px 4px 0;align-self:flex-start}',
    '.sys{align-self:center;font-size:12px;color:#6b7280;background:#eef0f3;padding:3px 10px;border-radius:10px}',
    '.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}.chip{border:1px solid var(--c);color:var(--c);background:#fff;border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer}.chip:hover{background:var(--c);color:#fff}',
    '.typing{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:10px 14px;display:flex;gap:4px}',
    '.typing i{width:6px;height:6px;border-radius:50%;background:#9ca3af;animation:b 1.2s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}',
    '@keyframes b{0%,60%,100%{transform:none;opacity:.5}30%{transform:translateY(-4px);opacity:1}}',
    '.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;font-size:13px;color:#374151}',
    '.card input{border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font:inherit;outline:none}.card input:focus{border-color:var(--c)}',
    '.card button{background:var(--c);color:#fff;border:0;border-radius:8px;padding:8px;font:inherit;font-weight:600;cursor:pointer}',
    '.err{color:#dc2626;font-size:12px}',
    '.m img{max-width:100%;border-radius:10px;display:block}.m a{color:inherit;text-decoration:underline}',
    '.stars{display:flex;gap:4px;justify-content:center}.stars button{background:none;border:0;font-size:26px;cursor:pointer;color:#d1d5db;padding:0}.stars button.on{color:#f59e0b}',
    'form.in .clip{background:none;color:#6b7280;font-size:18px;width:32px}',
    'form.in{display:flex;gap:8px;padding:12px;border-top:1px solid #e5e7eb;background:#fff}',
    'form.in textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:20px;padding:9px 14px;font:14px system-ui,sans-serif;outline:none;max-height:90px;height:38px}',
    'form.in textarea:focus{border-color:var(--c)}',
    'form.in button{width:38px;height:38px;border-radius:50%;border:0;background:var(--c);color:#fff;cursor:pointer;font-size:16px}',
    '.foot{font-size:11px;color:#9ca3af;text-align:center;padding:0 0 8px;background:#fff}'
  ].join('');
  root.appendChild(css);
  var wrap = el('div', 'wrap right'); root.appendChild(wrap);
  document.body ? document.body.appendChild(host) : document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(host); });

  var panel, msgsEl, inputEl, headDot, headSub, launcher, badge, teaser;
  var ICON = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 5.92 2 10.75c0 2.6 1.3 4.93 3.36 6.54L4.5 22l4.3-2.3c1.04.27 2.1.4 3.2.4 5.52 0 10-3.92 10-8.75S17.52 2 12 2z"/></svg>';

  function mount() {
    var s = state.settings;
    host.style.setProperty('--c', s.color); wrap.style.setProperty('--c', s.color);
    wrap.className = 'wrap ' + (s.position === 'left' ? 'left' : 'right');
    launcher = el('button', 'launcher'); launcher.innerHTML = ICON; launcher.setAttribute('aria-label', 'Open chat');
    badge = el('span', 'badge'); badge.style.display = 'none'; launcher.appendChild(badge);
    launcher.onclick = toggle; wrap.appendChild(launcher);
    if (store('chatly_open') === '1') toggle(true);
    else if (s.proactiveEnabled && !store('chatly_teased') && !state.messages.length) {
      setTimeout(function () {
        if (state.open || teaser) return;
        teaser = el('div', 'teaser', s.proactiveMessage); teaser.onclick = function () { toggle(true); };
        wrap.insertBefore(teaser, launcher); store('chatly_teased', '1');
        setBadge(1);
      }, Math.max(0, s.proactiveDelay) * 1000);
    }
  }
  function setBadge(n) { state.unread = n; if (!badge) return; badge.textContent = n; badge.style.display = n ? 'flex' : 'none'; }

  function buildPanel() {
    var s = state.settings;
    panel = el('div', 'panel');
    var head = el('div', 'head'), info = el('div');
    info.appendChild(el('div', 't', s.title));
    headSub = el('div', 's'); headDot = el('span', 'dot'); headSub.appendChild(headDot); headSub.appendChild(el('span', '', s.subtitle));
    info.appendChild(headSub); head.appendChild(info);
    var x = el('button', 'x', '×'); x.setAttribute('aria-label', 'Close'); x.onclick = function () { toggle(false); }; head.appendChild(x);
    msgsEl = el('div', 'msgs'); msgsEl.setAttribute('aria-live', 'polite');
    var form = el('form', 'in');
    var clip = el('button', 'clip', '📎'); clip.type = 'button'; clip.title = 'Attach a file'; clip.setAttribute('aria-label', 'Attach a file');
    var file = el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain'; file.style.display = 'none';
    clip.onclick = function () { file.click(); };
    file.onchange = function () { if (file.files[0]) upload(file.files[0]); file.value = ''; };
    inputEl = el('textarea'); inputEl.placeholder = 'Write a message…'; inputEl.rows = 1; inputEl.maxLength = 2000;
    var btn = el('button', '', '➤'); btn.type = 'submit'; btn.setAttribute('aria-label', 'Send');
    form.appendChild(clip); form.appendChild(file); form.appendChild(inputEl); form.appendChild(btn);
    form.onsubmit = function (e) { e.preventDefault(); sendText(inputEl.value); inputEl.value = ''; };
    inputEl.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } };
    inputEl.oninput = function () {
      if (Date.now() - lastTypingSent > 2500) { lastTypingSent = Date.now(); api('typing', {}).catch(function () {}); }
    };
    var foot = el('div', 'foot', 'Powered by ' + (s.brandName || 'Chatly'));
    panel.appendChild(head); panel.appendChild(msgsEl); panel.appendChild(form); panel.appendChild(foot);
    renderStatus(); render();
  }
  function renderStatus() { if (headDot) headDot.className = 'dot' + (state.agentsOnline ? ' on' : ''); }

  function toggle(force) {
    state.open = typeof force === 'boolean' ? force : !state.open;
    store('chatly_open', state.open ? '1' : '0');
    if (teaser) { teaser.remove(); teaser = null; }
    if (state.open) {
      if (!panel) buildPanel();
      wrap.insertBefore(panel, launcher); setBadge(0); render(); setTimeout(function () { inputEl && inputEl.focus(); }, 50);
    } else if (panel && panel.parentNode) panel.remove();
  }

  function render() {
    if (!msgsEl) return;
    msgsEl.textContent = '';
    if (!state.messages.length) {
      var g = el('div', 'm bot', state.settings.greeting); msgsEl.appendChild(g);
    }
    var lastIdx = state.messages.length - 1;
    state.messages.forEach(function (m, i) {
      if (m.sender === 'system') return msgsEl.appendChild(el('div', 'sys', m.body));
      var prev = state.messages[i - 1];
      if (m.sender !== 'visitor' && (!prev || prev.sender !== m.sender || prev.sender_name !== m.sender_name))
        msgsEl.appendChild(el('div', 'who', m.sender_name || (m.sender === 'bot' ? 'Bot' : 'Team')));
      var bub = el('div', 'm ' + m.sender);
      if (m.attachment) {
        var href = BASE + m.attachment.url;
        if (/^image\//.test(m.attachment.type)) { var a = el('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; var im = el('img'); im.src = href; im.alt = m.attachment.name; a.appendChild(im); bub.appendChild(a); }
        else { var l = el('a', '', '📎 ' + m.attachment.name); l.href = href; l.target = '_blank'; l.rel = 'noopener'; bub.appendChild(l); }
      } else bub.textContent = m.body;
      msgsEl.appendChild(bub);
      if (m.buttons && m.buttons.length && i === lastIdx) {
        var chips = el('div', 'chips');
        m.buttons.forEach(function (b) { var c = el('button', 'chip', b); c.onclick = function () { sendText(b); }; chips.appendChild(c); });
        msgsEl.appendChild(chips);
      }
    });
    if (state.needEmail) msgsEl.appendChild(emailCard());
    if (state.closed && state.settings.ratingEnabled) msgsEl.appendChild(ratingCard());
    if (state.typing) { var t = el('div', 'typing'); t.innerHTML = '<i></i><i></i><i></i>'; msgsEl.appendChild(t); }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function emailCard() {
    var c = el('div', 'card');
    c.appendChild(el('div', '', state.agentsOnline ? 'Want a reply by email too?' : 'Leave your email so we can reply when you are away:'));
    var name = el('input'); name.placeholder = 'Your name'; name.autocomplete = 'name';
    var email = el('input'); email.type = 'email'; email.placeholder = 'you@example.com'; email.autocomplete = 'email';
    var err = el('div', 'err'), b = el('button', '', 'Save');
    b.onclick = function () {
      api('identify', { name: name.value, email: email.value }).then(function (r) {
        if (r.error) err.textContent = r.error; else { state.needEmail = false; render(); }
      });
    };
    [name, email, err, b].forEach(function (n) { c.appendChild(n); });
    return c;
  }

  function ratingCard() {
    var c = el('div', 'card');
    if (state.rated) { c.appendChild(el('div', '', 'Thanks for your feedback! 💜')); return c; }
    c.appendChild(el('div', '', 'This chat was closed. How did we do?'));
    var stars = el('div', 'stars'), chosen = 0, btns = [];
    for (var i = 1; i <= 5; i++) (function (n) { var b = el('button', '', '★'); b.type = 'button'; b.setAttribute('aria-label', n + ' stars');
      b.onclick = function () { chosen = n; btns.forEach(function (x, j) { x.className = j < n ? 'on' : ''; }); }; btns.push(b); stars.appendChild(b); })(i);
    var note = el('input'); note.placeholder = 'Any comments? (optional)';
    var err = el('div', 'err'), send = el('button', '', 'Send feedback');
    send.onclick = function () {
      if (!chosen) { err.textContent = 'Pick a rating first'; return; }
      api('rate', { rating: chosen, comment: note.value }).then(function (r) { if (r.error) err.textContent = r.error; else { state.rated = true; render(); } });
    };
    [stars, note, err, send].forEach(function (n) { c.appendChild(n); });
    return c;
  }
  function resetIfClosed() { if (state.closed) { state.closed = false; state.rated = false; state.messages = []; state.ids = {}; state.needEmail = false; } }
  function upload(f) {
    if (f.size > 3000000) return alert('File too large (max 3 MB)');
    var r = new FileReader();
    r.onload = function () {
      resetIfClosed();
      api('upload', { name: f.name, type: f.type, data: String(r.result).split(',')[1] }).then(function (x) { if (x.error) alert(x.error); else if (x.message) addMessage(x.message); });
    };
    r.readAsDataURL(f);
  }
  function addMessage(m) {
    if (state.ids[m.id]) return; state.ids[m.id] = 1; state.messages.push(m);
    if (m.sender !== 'visitor') {
      state.typing = null;
      if (!state.open) { setBadge(state.unread + 1); }
    }
    render();
  }

  function sendText(text) {
    text = (text || '').trim(); if (!text) return;
    resetIfClosed();
    api('message', { body: text, page: location.href }).then(function (r) { if (r.message) addMessage(r.message); });
  }

  function connect() {
    if (es) es.close();
    es = new EventSource(BASE + '/api/widget/events?key=' + encodeURIComponent(KEY) + '&vid=' + encodeURIComponent(VID));
    es.addEventListener('ready', function (e) { state.agentsOnline = JSON.parse(e.data).agentsOnline; renderStatus(); });
    es.addEventListener('agents', function (e) { state.agentsOnline = JSON.parse(e.data).online; renderStatus(); });
    es.addEventListener('message', function (e) { addMessage(JSON.parse(e.data)); });
    es.addEventListener('typing', function (e) {
      var d = JSON.parse(e.data); state.typing = d.who; render();
      clearTimeout(typingTimer); typingTimer = setTimeout(function () { state.typing = null; render(); }, 3500);
    });
    es.addEventListener('closed', function () { state.closed = true; state.rated = false; state.typing = null; render(); });
    es.addEventListener('handoff', function (e) {
      state.agentsOnline = JSON.parse(e.data).online;
      if (state.settings.askEmail && !state.visitor.email) state.needEmail = true;
      renderStatus(); render();
    });
  }

  function track() {
    var last = location.href;
    setInterval(function () { if (location.href !== last) { last = location.href; api('ping', { page: last }).catch(function () {}); } }, 1500);
  }

  api('init', { page: location.href }).then(function (r) {
    if (r.error) return console.warn('[Chatly]', r.error);
    state.settings = r.settings; state.visitor = r.visitor; state.agentsOnline = r.agentsOnline;
    r.messages.forEach(function (m) { state.ids[m.id] = 1; state.messages.push(m); });
    mount(); connect(); track();
  }).catch(function (e) { console.warn('[Chatly] failed to load', e); });

  window.Chatly = { open: function () { toggle(true); }, close: function () { toggle(false); } };
})();
