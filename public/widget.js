/* Chatly embeddable chat widget. Usage:
   <script src="https://YOUR-HOST/widget.js" data-key="SITE_KEY" async></script> */
(function () {
  if (window.__chatly) return; window.__chatly = true;
  // Page builders (GTM, Wix, some Shopify apps) inject scripts dynamically, so currentScript can be null
  // and data- attributes can be stripped: also accept the key as ?key= in the script URL or window.ChatlyConfig.
  var script = document.currentScript || document.querySelector('script[src*="widget.js"][data-key]') || document.querySelector('script[src*="widget.js?key="]') || document.querySelector('script[src*="/widget.js"]');
  var src = script && script.src ? new URL(script.src, location.href) : null;
  var KEY = (script && script.getAttribute('data-key')) || (src && src.searchParams.get('key')) || (window.ChatlyConfig && window.ChatlyConfig.key);
  if (!KEY || !src) return console.error('[Chatly] Widget not started: no site key found. Paste the snippet from Chatly → Settings → Websites.');
  var BASE = (window.ChatlyConfig && window.ChatlyConfig.host) || src.origin;
  var store = function (k, v, session) { try { var s = session ? sessionStorage : localStorage; if (v === undefined) return s.getItem(k); s.setItem(k, v); } catch (e) {} };
  var VID = store('chatly_vid');
  if (!VID) { VID = 'v' + Array.from(crypto.getRandomValues(new Uint8Array(12))).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''); store('chatly_vid', VID); }

  var state = { settings: null, messages: [], open: false, unread: 0, agentsOnline: false, needEmail: false, typing: null, ids: {}, trigger: null, prechatDone: false, emoji: false };
  var es, typingTimer, lastTypingSent = 0;

  function api(path, body) {
    return fetch(BASE + '/api/widget/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ key: KEY, vid: VID }, body)) }).then(function (r) { return r.json().catch(function () { return { error: 'HTTP ' + r.status }; }); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function shade(hex, amt) { var n = parseInt(hex.slice(1), 16), f = function (v) { return Math.max(0, Math.min(255, Math.round(v + (amt < 0 ? v : 255 - v) * amt))); };
    return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(function (v) { return f(v).toString(16).padStart(2, '0'); }).join(''); }
  function timeStr(t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  var host = el('div'); host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;bottom:0;';
  var root = host.attachShadow({ mode: 'open' });
  var css = el('style'); css.textContent = [
    '*{box-sizing:border-box}.wrap,button,input,textarea{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '.wrap{--bg:#fff;--bg2:#f7f8fa;--tx:#111827;--mu:#6b7280;--bd:#e5e7eb;--bub:#fff;position:fixed;bottom:20px;display:flex;flex-direction:column;gap:12px}',
    '.wrap.dark{--bg:#1b1f2a;--bg2:#12151d;--tx:#e8eaf0;--mu:#9aa3b2;--bd:#2b3140;--bub:#262c3a}',
    '.wrap.left{left:20px;align-items:flex-start}.wrap.right{right:20px;align-items:flex-end}',
    '.launcher{height:60px;min-width:60px;border-radius:30px;border:0;cursor:pointer;background:var(--c);color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;gap:10px;padding:0 18px;position:relative;transition:transform .18s,box-shadow .18s;font-weight:600;font-size:15px}',
    '.launcher.circle{width:60px;padding:0}.launcher:hover{transform:translateY(-2px) scale(1.04)}.launcher svg{width:26px;height:26px;fill:#fff;flex:none}',
    '.badge{position:absolute;top:-5px;right:-5px;min-width:22px;height:22px;border-radius:11px;background:#ef4444;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 6px;border:2px solid #fff}',
    '.teaser{background:var(--bg);color:var(--tx);padding:14px 18px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.2);max-width:270px;font-size:14px;cursor:pointer;line-height:1.45;position:relative;animation:pop .25s ease-out}',
    '.teaser .tx{position:absolute;top:-8px;right:-8px;width:22px;height:22px;border-radius:50%;background:var(--mu);color:#fff;border:0;font-size:13px;line-height:1;cursor:pointer}',
    '.panel{width:380px;max-width:calc(100vw - 24px);height:600px;max-height:calc(100vh - 110px);background:var(--bg);color:var(--tx);border-radius:20px;box-shadow:0 16px 60px rgba(0,0,0,.32);display:flex;flex-direction:column;overflow:hidden;animation:pop .2s ease-out}',
    '@keyframes pop{from{opacity:0;transform:translateY(14px) scale(.96)}}',
    '.head{background:var(--hd);color:#fff;padding:18px 18px 22px;display:flex;align-items:center;gap:12px;position:relative}',
    '.av{width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden;font-size:22px}.av img{width:100%;height:100%;object-fit:cover}',
    '.head .t{font-weight:700;font-size:16px}.head .s{font-size:12.5px;opacity:.92;margin-top:2px;display:flex;align-items:center;gap:6px}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#9ca3af;flex:none}.dot.on{background:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.3)}',
    '.head .x{margin-left:auto;background:rgba(255,255,255,.18);border:0;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:20px;line-height:1}.head .x:hover{background:rgba(255,255,255,.3)}',
    '.msgs{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:3px;background:var(--bg2);margin-top:-12px;border-radius:16px 16px 0 0;position:relative}',
    '.row{display:flex;gap:8px;align-items:flex-end;max-width:88%}.row.visitor{align-self:flex-end;flex-direction:row-reverse}.row .mini{width:26px;height:26px;border-radius:50%;background:var(--c);color:#fff;font-size:13px;display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden}.row .mini img{width:100%;height:100%;object-fit:cover}',
    '.m{padding:10px 14px;border-radius:18px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}',
    '.m.visitor{background:var(--c);color:#fff;border-bottom-right-radius:5px}.m.agent,.m.bot{background:var(--bub);color:var(--tx);border:1px solid var(--bd);border-bottom-left-radius:5px}',
    '.meta{font-size:11px;color:var(--mu);margin:8px 6px 2px}.meta.visitor{align-self:flex-end}',
    '.sys{align-self:center;font-size:12px;color:var(--mu);background:var(--bd);padding:3px 12px;border-radius:12px;margin:6px 0}',
    '.chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px 34px}.chip{border:1.5px solid var(--c);color:var(--c);background:transparent;border-radius:18px;padding:7px 14px;font-size:13.5px;font-weight:500;cursor:pointer;transition:all .12s}.chip:hover,.chip.on{background:var(--c);color:#fff}',
    '.typing{align-self:flex-start;background:var(--bub);border:1px solid var(--bd);border-radius:18px;padding:12px 15px;display:flex;gap:4px;margin-left:34px}',
    '.typing i{width:7px;height:7px;border-radius:50%;background:var(--mu);animation:b 1.2s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}',
    '@keyframes b{0%,60%,100%{transform:none;opacity:.5}30%{transform:translateY(-4px);opacity:1}}',
    '.card{background:var(--bub);border:1px solid var(--bd);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:9px;font-size:13.5px;color:var(--tx);margin:8px 0}',
    '.card input{border:1px solid var(--bd);background:var(--bg);color:var(--tx);border-radius:10px;padding:10px 12px;font-size:14px;outline:none}.card input:focus{border-color:var(--c)}',
    '.card button{background:var(--c);color:#fff;border:0;border-radius:10px;padding:10px;font-size:14px;font-weight:600;cursor:pointer}.card button:hover{filter:brightness(1.08)}',
    '.err{color:#ef4444;font-size:12px}.m img.att{max-width:100%;border-radius:12px;display:block}.m a{color:inherit;text-decoration:underline}',
    '.stars{display:flex;gap:4px;justify-content:center}.stars button{background:none!important;border:0;font-size:30px;cursor:pointer;color:#cbd5e1!important;padding:0;transition:transform .1s}.stars button:hover{transform:scale(1.15)}.stars button.on{color:#f59e0b!important}',
    'form.in{display:flex;gap:6px;padding:10px 12px;border-top:1px solid var(--bd);background:var(--bg);align-items:flex-end;position:relative}',
    'form.in textarea{flex:1;resize:none;border:1px solid var(--bd);background:var(--bg2);color:var(--tx);border-radius:22px;padding:10px 16px;font-size:14.5px;outline:none;max-height:100px;height:40px;line-height:1.3}',
    'form.in textarea:focus{border-color:var(--c)}form.in textarea:disabled{opacity:.5}',
    'form.in .ic{background:none;border:0;color:var(--mu);font-size:19px;width:34px;height:40px;cursor:pointer;border-radius:50%;flex:none}form.in .ic:hover{color:var(--c)}',
    'form.in .send{width:40px;height:40px;border-radius:50%;border:0;background:var(--c);color:#fff;cursor:pointer;font-size:16px;flex:none}form.in .send:disabled{opacity:.4;cursor:default}',
    '.emo{position:absolute;bottom:58px;left:12px;right:12px;background:var(--bg);border:1px solid var(--bd);border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.2);padding:8px;display:grid;grid-template-columns:repeat(8,1fr);gap:2px;z-index:2}',
    '.emo button{background:none;border:0;font-size:21px;cursor:pointer;border-radius:8px;padding:4px}.emo button:hover{background:var(--bd)}',
    '.foot{font-size:11px;color:var(--mu);text-align:center;padding:0 0 8px;background:var(--bg)}.foot a{color:inherit}',
    '@media(max-width:480px){.panel{width:calc(100vw - 24px);height:calc(100vh - 100px)}}'
  ].join('');
  root.appendChild(css);
  var wrap = el('div', 'wrap right'); root.appendChild(wrap);
  document.body ? document.body.appendChild(host) : document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(host); });

  var panel, msgsEl, inputEl, sendBtn, headDot, launcher, badge, teaser;
  var ICON = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 5.92 2 10.75c0 2.6 1.3 4.93 3.36 6.54L4.5 22l4.3-2.3c1.04.27 2.1.4 3.2.4 5.52 0 10-3.92 10-8.75S17.52 2 12 2z"/></svg>';
  var EMOJI = '😀😃😄😁😆😅😂🤣😊😇🙂😉😍🥰😘😋😎🤩🥳🤔🙄😬😢😭😡👍👎👏🙌🙏💪👋🔥❤️💜🎉✨💯✅❌⭐🚀'.match(/\p{Extended_Pictographic}️?/gu);

  function isDark() { var t = state.settings.theme; return t === 'dark' || (t === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); }

  function mount() {
    var s = state.settings;
    wrap.style.setProperty('--c', s.color);
    wrap.style.setProperty('--hd', s.gradient ? 'linear-gradient(135deg,' + s.color + ',' + shade(s.color, -0.35) + ')' : s.color);
    wrap.className = 'wrap ' + (s.position === 'left' ? 'left' : 'right') + (isDark() ? ' dark' : '');
    launcher = el('button', s.launcherStyle === 'pill' ? 'launcher' : 'launcher circle'); launcher.innerHTML = ICON; launcher.setAttribute('aria-label', 'Open chat');
    if (s.launcherStyle === 'pill') launcher.appendChild(el('span', '', s.launcherLabel || 'Chat with us'));
    badge = el('span', 'badge'); badge.style.display = 'none'; launcher.appendChild(badge);
    launcher.onclick = function () { toggle(); }; wrap.appendChild(launcher);
    if (store('chatly_open') === '1') toggle(true);
    else if (s.proactiveEnabled && !store('chatly_teased') && !state.messages.length) schedule(s.proactiveDelay, s.proactiveMessage, false, null, function () { store('chatly_teased', '1'); });
    watchTriggers();
  }
  function schedule(delay, text, openChat, triggerId, done) {
    setTimeout(function () {
      if (state.open || teaser || state.messages.length) return;
      if (triggerId) state.trigger = triggerId;
      if (openChat) { toggle(true); return; }
      teaser = el('div', 'teaser', text);
      var x = el('button', 'tx', '×'); x.setAttribute('aria-label', 'Dismiss');
      x.onclick = function (e) { e.stopPropagation(); teaser.remove(); teaser = null; };
      teaser.appendChild(x); teaser.onclick = function () { toggle(true); };
      wrap.insertBefore(teaser, launcher); setBadge(1); done && done();
    }, Math.max(0, delay) * 1000);
  }
  var fired = {};
  function watchTriggers() {
    var check = function () {
      (state.settings.triggers || []).forEach(function (t) {
        if (fired[t.id] || store('chatly_trig_' + t.id, undefined, true)) return;
        if (t.url_contains && location.href.indexOf(t.url_contains) < 0) return;
        fired[t.id] = 1; store('chatly_trig_' + t.id, '1', true);
        schedule(t.delay, t.message, t.open_chat, t.id);
      });
    };
    check(); setInterval(check, 1500);
  }
  function setBadge(n) { state.unread = n; if (!badge) return; badge.textContent = n; badge.style.display = n ? 'flex' : 'none'; }

  function avatar(cls) {
    var a = el('div', cls), s = state.settings;
    if (s.avatarUrl) { var i = el('img'); i.src = s.avatarUrl; i.alt = ''; a.appendChild(i); } else a.textContent = cls === 'av' ? '💬' : '🤖';
    return a;
  }

  function buildPanel() {
    var s = state.settings;
    panel = el('div', 'panel');
    var head = el('div', 'head'), info = el('div');
    info.appendChild(el('div', 't', s.title));
    var sub = el('div', 's'); headDot = el('span', 'dot'); sub.appendChild(headDot); sub.appendChild(el('span', '', s.subtitle)); info.appendChild(sub);
    head.appendChild(avatar('av')); head.appendChild(info);
    var x = el('button', 'x', '×'); x.setAttribute('aria-label', 'Close'); x.onclick = function () { toggle(false); }; head.appendChild(x);
    msgsEl = el('div', 'msgs'); msgsEl.setAttribute('aria-live', 'polite');
    var form = el('form', 'in');
    var emo = el('button', 'ic', '😊'); emo.type = 'button'; emo.setAttribute('aria-label', 'Emoji');
    emo.onclick = function () { state.emoji = !state.emoji; drawEmoji(form); };
    var clip = el('button', 'ic', '📎'); clip.type = 'button'; clip.setAttribute('aria-label', 'Attach a file');
    var file = el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain'; file.style.display = 'none';
    clip.onclick = function () { file.click(); };
    file.onchange = function () { if (file.files[0]) upload(file.files[0]); file.value = ''; };
    inputEl = el('textarea'); inputEl.placeholder = 'Write a message…'; inputEl.rows = 1; inputEl.maxLength = 2000;
    sendBtn = el('button', 'send', '➤'); sendBtn.type = 'submit'; sendBtn.setAttribute('aria-label', 'Send');
    [emo, clip, file, inputEl, sendBtn].forEach(function (n) { form.appendChild(n); });
    form.onsubmit = function (e) { e.preventDefault(); sendText(inputEl.value); inputEl.value = ''; inputEl.style.height = '40px'; };
    inputEl.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } };
    inputEl.oninput = function () {
      inputEl.style.height = '40px'; inputEl.style.height = Math.min(100, inputEl.scrollHeight) + 'px';
      if (Date.now() - lastTypingSent > 2500) { lastTypingSent = Date.now(); api('typing', {}).catch(function () {}); }
    };
    var foot = el('div', 'foot'); if (s.showBranding !== false) foot.textContent = '⚡ Powered by ' + (s.brandName || 'Chatly'); else foot.style.display = 'none';
    panel.appendChild(head); panel.appendChild(msgsEl); panel.appendChild(form); panel.appendChild(foot);
    renderStatus(); render();
  }
  function drawEmoji(form) {
    var old = form.querySelector('.emo'); if (old) old.remove();
    if (!state.emoji) return;
    var box = el('div', 'emo');
    EMOJI.forEach(function (e) { var b = el('button', '', e); b.type = 'button'; b.onclick = function () { inputEl.value += e; inputEl.focus(); }; box.appendChild(b); });
    form.appendChild(box);
  }
  function renderStatus() { if (headDot) headDot.className = 'dot' + (state.agentsOnline ? ' on' : ''); }

  function toggle(force) {
    state.open = typeof force === 'boolean' ? force : !state.open;
    store('chatly_open', state.open ? '1' : '0');
    if (teaser) { teaser.remove(); teaser = null; }
    if (state.open) {
      if (!panel) buildPanel();
      wrap.insertBefore(panel, launcher); launcher.style.display = window.innerWidth <= 480 ? 'none' : ''; setBadge(0); render();
      setTimeout(function () { inputEl && !inputEl.disabled && inputEl.focus(); }, 50);
    } else if (panel && panel.parentNode) { panel.remove(); launcher.style.display = ''; }
  }

  function needsPrechat() { var s = state.settings; return s.prechatForm && !state.prechatDone && !state.visitor.email && !state.messages.length; }

  function render() {
    if (!msgsEl) return;
    var prechat = needsPrechat();
    inputEl.disabled = prechat; sendBtn.disabled = prechat; inputEl.placeholder = prechat ? 'Fill in the form above to start…' : 'Write a message…';
    msgsEl.textContent = '';
    if (!state.messages.length) msgsEl.appendChild(row('bot', el('div', 'm bot', state.settings.greeting)));
    if (prechat) msgsEl.appendChild(prechatCard());
    var deps = state.settings.departments || [];
    if (!state.messages.length && !prechat && deps.length) {
      msgsEl.appendChild(el('div', 'sys', 'What can we help you with?'));
      var dc = el('div', 'chips');
      deps.forEach(function (d) { var c = el('button', 'chip' + (state.department === d.id ? ' on' : ''), (state.department === d.id ? '✓ ' : '') + d.name); c.onclick = function () { state.department = state.department === d.id ? null : d.id; render(); inputEl.focus(); }; dc.appendChild(c); });
      msgsEl.appendChild(dc);
    }
    var lastIdx = state.messages.length - 1, lastKey = null, lastTime = 0;
    state.messages.forEach(function (m, i) {
      if (m.sender === 'system') { lastKey = null; return msgsEl.appendChild(el('div', 'sys', m.body)); }
      var key = m.sender + (m.sender_name || '');
      if (key !== lastKey || m.created - lastTime > 5 * 60000) {
        var who = m.sender === 'visitor' ? 'You' : (m.sender_name || (m.sender === 'bot' ? 'Bot' : 'Team'));
        msgsEl.appendChild(el('div', 'meta ' + m.sender, who + ' · ' + timeStr(m.created)));
      }
      lastKey = key; lastTime = m.created;
      var bub = el('div', 'm ' + m.sender);
      if (m.attachment) {
        var href = BASE + m.attachment.url;
        if (/^image\//.test(m.attachment.type)) { var a = el('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; var im = el('img', 'att'); im.src = href; im.alt = m.attachment.name; a.appendChild(im); bub.appendChild(a); }
        else { var l = el('a', '', '📎 ' + m.attachment.name); l.href = href; l.target = '_blank'; l.rel = 'noopener'; bub.appendChild(l); }
      } else bub.textContent = m.body;
      msgsEl.appendChild(row(m.sender, bub));
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
  function row(sender, bubble) {
    var r = el('div', 'row ' + sender);
    if (sender !== 'visitor') { var mini = el('div', 'mini'); if (state.settings.avatarUrl) { var i = el('img'); i.src = state.settings.avatarUrl; i.alt = ''; mini.appendChild(i); } else mini.textContent = sender === 'bot' ? '🤖' : '👤'; r.appendChild(mini); }
    r.appendChild(bubble); return r;
  }

  function formCard(title, withName, btnText, onSubmit) {
    var c = el('div', 'card'); c.appendChild(el('div', '', title));
    var name = withName ? el('input') : null, email = el('input'), err = el('div', 'err'), b = el('button', '', btnText);
    if (name) { name.placeholder = 'Your name'; name.autocomplete = 'name'; c.appendChild(name); }
    email.type = 'email'; email.placeholder = 'you@example.com'; email.autocomplete = 'email'; c.appendChild(email); c.appendChild(err); c.appendChild(b);
    b.onclick = function () { err.textContent = ''; onSubmit({ name: name ? name.value : '', email: email.value }, function (m) { err.textContent = m; }); };
    return c;
  }
  function emailCard() {
    return formCard(state.agentsOnline ? 'Want a reply by email too?' : 'Leave your email so we can reply when you are away:', true, 'Save', function (v, fail) {
      api('identify', v).then(function (r) { if (r.error) fail(r.error); else { state.needEmail = false; state.visitor.email = v.email; render(); } });
    });
  }
  function prechatCard() {
    return formCard('Before we start, tell us who you are:', true, 'Start chat', function (v, fail) {
      if (!v.name.trim()) return fail('Please enter your name');
      if (!v.email.trim()) return fail('Please enter your email');
      api('identify', v).then(function (r) { if (r.error) fail(r.error); else { state.prechatDone = true; state.visitor.email = v.email; state.visitor.name = v.name; render(); inputEl.focus(); } });
    });
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
    if (m.sender !== 'visitor') { state.typing = null; if (!state.open) setBadge(state.unread + 1); }
    render();
  }
  function sendText(text) {
    text = (text || '').trim(); if (!text || needsPrechat()) return;
    resetIfClosed(); state.emoji = false;
    var form = panel && panel.querySelector('form.in'); if (form) drawEmoji(form);
    var body = { body: text, page: location.href }; if (state.trigger) { body.trigger = state.trigger; state.trigger = null; }
    if (state.department && !state.messages.length) body.department_id = state.department;
    api('message', body).then(function (r) {
      if (r.message) addMessage(r.message);
      else if (r.error) { state.messages.push({ id: 'err' + Date.now(), sender: 'system', body: '⚠️ Message not sent: ' + r.error, created: Date.now() }); render(); }
    });
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
    es.addEventListener('closed', function () { state.closed = true; state.rated = false; state.typing = null; state.needEmail = false; render(); });
    es.addEventListener('handoff', function (e) {
      var d = JSON.parse(e.data); state.agentsOnline = d.online;
      if (state.settings.askEmail && !d.hasEmail) state.needEmail = true;
      renderStatus(); render();
    });
  }
  function track() {
    var last = location.href;
    setInterval(function () { if (location.href !== last) { last = location.href; api('ping', { page: last }).catch(function () {}); } }, 1500);
  }

  api('init', { page: location.href }).then(function (r) {
    if (r.error) return console.error('[Chatly] Widget not started: ' + r.error);
    state.settings = r.settings; state.visitor = r.visitor || {}; state.agentsOnline = r.agentsOnline;
    r.messages.forEach(function (m) { state.ids[m.id] = 1; state.messages.push(m); });
    mount(); connect(); track();
    if (pendingOpen !== null) toggle(pendingOpen);
    window.Chatly.ready = true; window.dispatchEvent(new CustomEvent('chatly:ready'));
  }).catch(function (e) { console.error('[Chatly] Widget not started: could not reach ' + BASE + ' (' + e.message + '). Check the server is running and not blocked by an ad blocker or Content-Security-Policy.'); });

  // open()/close() called before the widget finished loading are applied once it is ready
  var pendingOpen = null;
  window.Chatly = { ready: false, open: function () { if (state.settings) toggle(true); else pendingOpen = true; }, close: function () { if (state.settings) toggle(false); else pendingOpen = false; } };
})();
