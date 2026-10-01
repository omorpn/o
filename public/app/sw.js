// Chatly dashboard service worker: shows push notifications and focuses the dashboard when one is clicked.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Chatly', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Chatly', {
    body: data.body || '', tag: data.tag || undefined, renotify: !!data.tag, data: { url: data.url || '/app/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/app/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = wins.find(w => w.url.startsWith(self.location.origin + '/app'));
    if (existing) { await existing.focus(); existing.postMessage({ type: 'open', url }); }
    else await clients.openWindow(url);
  })());
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(clients.claim()));
