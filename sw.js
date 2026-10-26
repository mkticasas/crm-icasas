// Service worker do CRM iCasas — notificações + garante sempre a versão mais nova (não faz cache)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Ao abrir o app, busca a página direto do servidor (sem cache do iPhone)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return;
  event.respondWith(fetch(req, { cache: 'no-store' }).catch(() => fetch(req)));
});

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'CRM iCasas', {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag,
    data: { url: d.url || './', leadId: d.leadId || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, leadId } = event.notification.data || {};
  event.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const crm = abertas.find((c) => c.url.includes('/crm-icasas/'));
    if (crm) {
      await crm.focus();
      if (leadId) crm.postMessage({ abrirLead: leadId });
      return;
    }
    await self.clients.openWindow(url || './');
  })());
});
