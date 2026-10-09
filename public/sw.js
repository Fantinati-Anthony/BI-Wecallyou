// Service worker : affiche la notification « C'est à vous ! » reçue pour un ticket.
// Le contenu arrive chiffré de bout en bout ; le navigateur le déchiffre avant cet événement.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() ?? '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'WeCall.You', {
      body: data.body || '',
      tag: data.tag || 'ticket',
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 150, 400, 150, 800],
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.toUpperCase().startsWith(url.toUpperCase()));
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
