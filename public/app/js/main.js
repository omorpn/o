// Dashboard entry point. Each feature lives in its own ES module under js/.
import { S, api, hooks } from './core.js';
import { renderLogin } from './auth.js';
import { boot } from './shell.js';

window.addEventListener('focus', () => { if (S.view === 'inbox' && S.cur) api(`/conversations/${S.cur}/read`, 'POST').catch(() => {}); });
hooks.unauthorized = () => renderLogin();
boot();
