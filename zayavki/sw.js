/* Service worker админки YanaPro: чистый Web Push (VAPID), без Firebase */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'Новая запись';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: 'icon/logo.png',
    badge: 'icon/logo.png',
  }));
});

/* Локальные уведомления из открытой вкладки (polling нашёл новую запись) */
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'notify') {
    self.registration.showNotification(d.title || 'Новая запись', {
      body: d.body || '',
      icon: 'icon/logo.png',
      badge: 'icon/logo.png',
    });
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
