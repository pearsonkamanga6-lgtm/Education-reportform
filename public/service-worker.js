const CACHE = 'edusend-shell-v2-3-0';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/pwa.js',
  '/manifest.webmanifest', '/manifest.json', '/offline.html',
  '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type:'window' }))
      .then(clients => clients.forEach(c => c.postMessage({ type:'EDUSEND_UPDATED', version:'2.3.0' })))
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache:'no-store' })
        .then(res => { const copy=res.clone(); caches.open(CACHE).then(c=>c.put('/index.html',copy)); return res; })
        .catch(async () => (await caches.match('/index.html')) || (await caches.match('/offline.html')))
    );
    return;
  }

  const core = ['/app.js','/styles.css','/pwa.js','/manifest.webmanifest','/manifest.json','/service-worker.js'];
  if (core.includes(url.pathname)) {
    event.respondWith(
      fetch(req, { cache:'no-store' })
        .then(res => { if(res&&res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy));} return res; })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(caches.match(req).then(cached => cached || fetch(req).then(res => {
    if (res && res.ok) { const copy=res.clone(); caches.open(CACHE).then(c=>c.put(req,copy)); }
    return res;
  })));
});
