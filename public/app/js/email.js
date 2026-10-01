// Settings → Email channel: support mailboxes, their private inbound URL, provider setup steps, auto-replies, signature.
import { S, api, appendTo, guard, h, mod, toast } from './core.js';
import { renderShell } from './shell.js';
import { PRIORITY } from './inbox.js';

const copy = text => { navigator.clipboard?.writeText(text); toast('Copied'); };
const SETUP = [
  ['Postmark', 'Servers → your server → Inbound stream → set the Webhook URL to the address below. Point your domain\'s MX to inbound.postmarkapp.com, or forward your support address to the Postmark inbound address.'],
  ['Mailgun', 'Receiving → Create route → match recipient support@… → action “Forward” to the address below (store and notify also works).'],
  ['SendGrid', 'Settings → Inbound Parse → Add host & URL → paste the address below. Tick “POST the raw, full MIME message” for the best results.'],
  ['Cloudflare Email Routing', 'Create an Email Worker that does fetch(URL, { method: "POST", headers: { "Content-Type": "message/rfc822" }, body: message.raw }) and route your support address to it.'],
  ['Anything else', 'POST the raw email with Content-Type: message/rfc822, or JSON { "from", "subject", "text", "message_id", "in_reply_to" }.'],
];

export async function renderEmailSettings(page) {
  const d = await api('/mailboxes');
  appendTo(page,
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Email channel'), h('button', { class: 'btn', onclick: () => edit(null) }, '+ Connect a mailbox')),
      h('p', { class: 'hint' }, 'Emails to your support address become tickets. Replies thread automatically and reopen the ticket; your answers are emailed back with your signature, and the customer\'s reply lands on the same ticket.'),
      d.smtp ? h('div', { class: 'note ok' }, `✓ Outgoing email is configured — replies are sent from ${d.sendingAddress || 'the SMTP account'}, with Reply-To set to your mailbox address.`)
        : h('div', { class: 'note warn' }, '⚠ Outgoing email (SMTP_URL) is not configured on this server, so replies and auto-replies can\'t be emailed yet. Incoming email still creates tickets.')),
    ...(d.mailboxes.length ? d.mailboxes.map(mb => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, mb.name), ' ', h('span', { class: 'hint', style: 'margin:0' }, mb.address), ' ', mb.enabled ? h('span', { class: 'pill ok' }, 'receiving') : h('span', { class: 'pill' }, 'paused')),
        h('button', { class: 'btn sec sm', onclick: () => testDialog(mb) }, 'Send a test'), h('button', { class: 'btn sec sm', onclick: () => edit(mb) }, 'Edit'),
        h('button', { class: 'btn danger sm', onclick: guard(async () => { if (!confirm(`Disconnect ${mb.address}? Existing tickets stay.`)) return; await api('/mailboxes/' + mb.id, 'DELETE'); renderShell(); }) }, 'Delete')),
      h('label', {}, 'Inbound address (keep it secret)'),
      h('div', { class: 'row' }, h('input', { value: mb.inbound_url, readonly: true, style: 'flex:1;min-width:0', onclick: e => e.target.select() }), h('button', { class: 'btn sec sm', onclick: () => copy(mb.inbound_url) }, 'Copy'),
        h('button', { class: 'btn sec sm', title: 'Issue a new address; the old one stops working', onclick: guard(async () => { if (!confirm('Generate a new inbound address? Update your email provider afterwards.')) return; await api(`/mailboxes/${mb.id}/rotate`, 'POST'); toast('New address issued'); renderShell(); }) }, 'Rotate')),
      h('div', { class: 'hint' }, `${mb.received} email(s) received${mb.last_received ? ' · last ' + new Date(mb.last_received).toLocaleString() : ''} · new tickets: ${PRIORITY[mb.priority][1]} priority${mb.department_id ? ' · ' + (S.departments.find(x => x.id === mb.department_id)?.name || '') : ''} · auto-reply ${mb.auto_reply ? 'on' : 'off'}`),
      mb.last_error ? h('div', { class: 'note warn' }, '⚠ ' + mb.last_error) : null,
      h('details', {}, h('summary', { class: 'hint', style: 'cursor:pointer;margin-top:8px' }, 'How to connect your email provider'),
        h('dl', { class: 'setup' }, ...SETUP.flatMap(([n, t]) => [h('dt', {}, n), h('dd', {}, t)])))))
      : [h('div', { class: 'card empty' }, h('div', { class: 'big' }, '✉️'), 'No mailbox connected yet')]));

  function edit(mb) {
    const f = { name: h('input', { value: mb?.name || 'Support', placeholder: 'Support' }), address: h('input', { type: 'email', value: mb?.address || '', placeholder: 'support@yourshop.com' }),
      from_name: h('input', { value: mb?.from_name || '', placeholder: S.workspace?.name || 'Your company' }), signature: h('textarea', { rows: 3, placeholder: 'Kind regards,\nThe Support team' }, mb?.signature || ''),
      priority: h('select', {}, ...Object.entries(PRIORITY).reverse().map(([k, [e, l]]) => h('option', { value: k, selected: (mb?.priority || 'normal') === k }, `${e} ${l}`.trim()))),
      department: mod('departments') && S.departments.length ? h('select', {}, h('option', { value: '' }, 'No department'), ...S.departments.map(x => h('option', { value: x.id, selected: mb?.department_id === x.id }, x.name))) : null,
      auto: h('input', { type: 'checkbox', checked: mb ? mb.auto_reply : true }), autoText: h('textarea', { rows: 5 }, mb?.auto_reply_text || 'Hi {name},\n\nThanks for contacting us — we received your message and opened request #{number}: "{subject}".\nOur team will get back to you as soon as possible. Just reply to this email to add more details.'),
      enabled: h('input', { type: 'checkbox', checked: mb ? mb.enabled : true }) };
    const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:560px;max-width:96vw;max-height:92vh;overflow:auto' }, h('h3', {}, mb ? 'Edit mailbox' : 'Connect a mailbox'),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Name'), f.name), h('div', {}, h('label', {}, 'Support address'), f.address)),
      h('label', {}, 'Sender name on replies'), f.from_name, h('label', {}, 'Signature'), f.signature,
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Priority for new tickets'), f.priority), f.department ? h('div', {}, h('label', {}, 'Department'), f.department) : h('div')),
      h('label', { class: 'inline' }, f.auto, 'Send an automatic acknowledgement to new requests'), f.autoText, h('div', { class: 'hint' }, 'Placeholders: {name}, {number}, {subject}. Never sent to automated emails (out-of-office, bounces).'),
      h('label', { class: 'inline' }, f.enabled, 'Receiving (turn off to pause this mailbox)'),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
        h('button', { class: 'btn', onclick: guard(async () => {
          const body = { name: f.name.value, address: f.address.value, from_name: f.from_name.value, signature: f.signature.value, priority: f.priority.value, auto_reply: f.auto.checked, auto_reply_text: f.autoText.value, enabled: f.enabled.checked,
            ...(f.department && { department_id: f.department.value ? +f.department.value : null }) };
          await api(mb ? '/mailboxes/' + mb.id : '/mailboxes', mb ? 'PUT' : 'POST', body); md.remove(); toast(mb ? 'Saved' : 'Mailbox connected — now set up forwarding with the inbound address'); renderShell();
        }) }, mb ? 'Save' : 'Connect'))));
    document.body.append(md); f.address.focus();
  }
  function testDialog(mb) {
    const from = h('input', { type: 'email', value: S.me.email }), subject = h('input', { value: 'Test email' }), text = h('textarea', { rows: 3 }, 'Hello! Just checking the email channel works.');
    const md = h('div', { class: 'modal' }, h('div', { class: 'card', style: 'width:460px;max-width:96vw' }, h('h3', {}, 'Simulate an incoming email'),
      h('p', { class: 'hint' }, `Files a message as if it was sent to ${mb.address}. Use your own address to receive the reply.`),
      h('label', {}, 'From'), from, h('label', {}, 'Subject'), subject, h('label', {}, 'Message'), text,
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', { class: 'btn sec', onclick: () => md.remove() }, 'Cancel'),
        h('button', { class: 'btn', onclick: guard(async () => {
          const r = await api(`/mailboxes/${mb.id}/test`, 'POST', { from: from.value, subject: subject.value, text: text.value }); md.remove();
          toast(r.ticket ? `Ticket #${r.ticket.number} ${r.action === 'replied' ? 'updated' : 'created'}` : `Ignored: ${r.reason}`);
        }) }, 'Send test'))));
    document.body.append(md);
  }
}
