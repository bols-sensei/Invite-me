/* Service worker : coque applicative disponible hors ligne. Les API ne sont jamais mises en cache. */
const STATIC = 'ia-static-v4', PAGES = 'ia-pages-v1';
const SHELL = ['/static/css/app.css', '/static/js/main.js', '/static/js/core.js', '/static/js/home.js', '/static/js/event.js', '/static/js/scanner.js', '/static/js/offline.js',
  '/static/fonts/display.woff2', '/static/fonts/body.woff2', '/static/icons/icon.svg', '/static/manifest.webmanifest'];

self.addEventListener('install', e => { e.waitUntil(caches.open(STATIC).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => ![STATIC, PAGES].includes(n)).map(n => caches.delete(n)))).then(() => self.clients.claim())); });
self.addEventListener('message', e => { if (e.data === 'clear-pages') e.waitUntil(caches.delete(PAGES)); });

self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/static/')) {                       // stale-while-revalidate
    e.respondWith(caches.open(STATIC).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (req.mode === 'navigate') {                                  // réseau d'abord, copie de secours hors ligne
    e.respondWith(fetch(req).then(r => {
      if (r.ok && !r.redirected && (u.pathname === '/' || u.pathname.startsWith('/event/'))) { const copy = r.clone(); caches.open(PAGES).then(c => c.put(req, copy)); }
      return r;
    }).catch(async () => (await caches.match(req)) || (await caches.match('/')) || Response.error()));
  }
});
