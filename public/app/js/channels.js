// Settings → Channels: connect WhatsApp (Cloud API), Messenger and Instagram with the business's own Meta app.
import { S, api, appendTo, guard, h, toast } from './core.js';
import { renderShell } from './shell.js';

export const CH = { whatsapp: ['🟢', 'WhatsApp'], messenger: ['🔵', 'Messenger'], instagram: ['🟣', 'Instagram'], web: ['💬', 'Website'] };
const copy = t => { navigator.clipboard?.writeText(t); toast('Copied'); };
const HELP = {
  whatsapp: ['In Meta for Developers create an app (type Business) and add the WhatsApp product.', 'WhatsApp → API setup: copy the Phone number ID. Create a permanent token (Business settings → System users) with whatsapp_business_messaging.', 'App settings → Basic: copy the App secret.', 'After connecting, WhatsApp → Configuration → Webhook: paste the callback URL and verify token below, then subscribe to “messages”.'],
  messenger: ['Add the Messenger product to your Meta app and connect your Facebook Page.', 'Generate a Page access token (pages_messaging) and copy the Page ID.', 'App settings → Basic: copy the App secret.', 'After connecting, Messenger → Webhooks: paste the callback URL and verify token, subscribe the Page to “messages” and “messaging_postbacks”.'],
  instagram: ['Link your Instagram professional account to a Facebook Page and add Instagram messaging to your Meta app.', 'Copy the Instagram account ID and the Page ID; use a Page access token with instagram_manage_messages.', 'App settings → Basic: copy the App secret.', 'After connecting, set the webhook (callback URL + verify token) for the Instagram “messages” field.'],
};

export async function renderChannels(page) {
  const d = await api('/channels');
  appendTo(page,
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Messaging channels'),
      ...['whatsapp', 'messenger', 'instagram'].map(t => h('button', { class: 'btn' + (t === 'whatsapp' ? '' : ' sec'), onclick: () => connect(t) }, `${CH[t][0]} Connect ${CH[t][1]}`))),
      h('p', { class: 'hint' }, 'Messages from your WhatsApp number, Facebook Page and Instagram account arrive in the inbox like website chats — the chatbot, flows, AI answers, routing and notifications all work the same. Replies go back to the customer\'s app.'),
      d.dataKey ? null : h('div', { class: 'note warn' }, 'Tip for the platform owner: set DATA_KEY on the server so access tokens are encrypted in the database.')),
    ...d.channels.map(ch => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, `${CH[ch.type][0]} ${ch.name}`), ' ', h('span', { class: 'hint', style: 'margin:0' }, ch.display || ch.account_id), ' ', h('span', { class: 'pill ' + (ch.enabled ? 'ok' : '') }, ch.enabled ? 'connected' : 'paused')),
        h('button', { class: 'btn sec sm', onclick: guard(async () => { const r = await api(`/channels/${ch.id}/test`, 'POST'); toast(r.ok ? `✓ Connected: ${r.display}` : `✗ ${r.error}`); renderShell(); }) }, 'Test'),
        h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('/channels/' + ch.id, 'PUT', { enabled: !ch.enabled }); renderShell(); }) }, ch.enabled ? 'Pause' : 'Resume'),
        h('button', { class: 'btn sec sm', onclick: guard(async () => { const t = prompt('Paste a new access token'); if (t) { await api('/channels/' + ch.id, 'PUT', { token: t }); toast('Token updated'); renderShell(); } }) }, 'New token'),
        h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm(`Disconnect ${ch.display}?`)) { await api('/channels/' + ch.id, 'DELETE'); renderShell(); } }) }, 'Disconnect')),
      h('div', { class: 'grid2', style: 'margin-top:8px' },
        h('div', {}, h('label', {}, 'Webhook callback URL'), h('div', { class: 'row' }, h('input', { value: ch.webhook_url, readonly: true, style: 'flex:1;min-width:0' }), h('button', { class: 'btn sec sm', onclick: () => copy(ch.webhook_url) }, 'Copy'))),
        h('div', {}, h('label', {}, 'Verify token'), h('div', { class: 'row' }, h('input', { value: ch.verify_token, readonly: true, style: 'flex:1;min-width:0' }), h('button', { class: 'btn sec sm', onclick: () => copy(ch.verify_token) }, 'Copy')))),
      h('div', { class: 'hint' }, `Website: ${S.sites.find(s => s.id === ch.site_id)?.name || '—'} (its chatbot and settings apply) · token ${ch.token} · ${ch.last_inbound ? 'last message ' + new Date(ch.last_inbound).toLocaleString() : 'no messages yet'}`),
      ch.last_error ? h('div', { class: 'note warn' }, '⚠ ' + ch.last_error) : null)),
    d.channels.length ? null : h('div', { class: 'card empty' }, h('div', { class: 'big' }, '📱'), 'No channels connected yet'));
}

function connect(type) {
  const f = { name: h('input', { value: CH[type][1] }), account: h('input', { placeholder: type === 'whatsapp' ? 'Phone number ID, e.g. 109876543210' : type === 'messenger' ? 'Page ID' : 'Instagram account ID' }),
    page: type === 'instagram' ? h('input', { placeholder: 'Facebook Page ID linked to the account' }) : null, token: h('input', { type: 'password', placeholder: 'Access token' }), secret: h('input', { type: 'password', placeholder: 'App secret' }),
    site: h('select', {}, ...S.sites.map(s => h('option', { value: s.id }, s.name))) };
  const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:560px;max-width:96vw;max-height:92vh;overflow:auto' }, h('h3', {}, `${CH[type][0]} Connect ${CH[type][1]}`),
    h('ol', { class: 'steps' }, ...HELP[type].map(s => h('li', {}, s))),
    h('label', {}, 'Name in Chatly'), f.name, h('label', {}, type === 'whatsapp' ? 'Phone number ID' : type === 'messenger' ? 'Page ID' : 'Instagram account ID'), f.account,
    f.page ? [h('label', {}, 'Page ID'), f.page] : null, h('label', {}, 'Access token'), f.token, h('label', {}, 'App secret'), f.secret,
    S.sites.length > 1 ? [h('label', {}, 'Use the chatbot and settings of website'), f.site] : null,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
      h('button', { class: 'btn', onclick: guard(async () => {
        const r = await api('/channels', 'POST', { type, name: f.name.value, account_id: f.account.value, page_id: f.page?.value, token: f.token.value, app_secret: f.secret.value, site_id: +f.site.value });
        md.remove(); toast(`Connected ${r.channel.display} — now add the webhook in Meta`); renderShell();
      }) }, 'Connect'))));
  document.body.append(md); f.account.focus();
}

/** WhatsApp template dialog (outside the 24-hour window). */
export function templateDialog(conv) {
  const name = h('input', { placeholder: 'order_update' }), lang = h('input', { value: 'en', style: 'width:90px' }), params = h('input', { placeholder: 'Values for {{1}}, {{2}}… separated by |' });
  const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:480px;max-width:96vw' }, h('h3', {}, 'Send a WhatsApp template'),
    h('p', { class: 'hint' }, 'WhatsApp only allows free-form replies within 24 hours of the customer\'s last message. After that, start with a template approved in WhatsApp Manager; once they reply, you can chat normally again.'),
    h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('label', {}, 'Template name'), name), h('div', {}, h('label', {}, 'Language'), lang)), h('label', {}, 'Variables'), params,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
      h('button', { class: 'btn', onclick: guard(async () => { await api(`/conversations/${conv.id}/template`, 'POST', { name: name.value, language: lang.value, params: params.value ? params.value.split('|').map(x => x.trim()) : [] }); md.remove(); toast('Template sent'); }) }, 'Send'))));
  document.body.append(md); name.focus();
}
