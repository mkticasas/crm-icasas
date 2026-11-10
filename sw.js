// Service worker do CRM iCasas — notificações + garante sempre a versão mais nova (não faz cache)
// Mudar SW_VERSAO força todo celular com o app aberto a recarregar na versão nova
const SW_VERSAO = '2026-11-10-1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  await self.clients.claim();
  const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of janelas) {
    try {
      const u = new URL(c.url);
      u.searchParams.set('_v', Date.now());
      await c.navigate(u.toString());
    } catch (_) {}
  }
})()));

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
