const CACHE = 'edusend-shell-v2-8-0';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/pwa.js',
  '/manifest.webmanifest', '/manifest.json', '/offline.html',
  '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'
];

async function precacheShell(){
  const cache=await caches.open(CACHE);
  // One missing optional asset should not make the whole install fail.
  await Promise.allSettled(SHELL.map(async url=>{
    const res=await fetch(url,{cache:'no-store'});
    if(res.ok) await cache.put(url,res);
  }));
}

self.addEventListener('install', event => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type:'window' }))
      .then(clients => clients.forEach(c => c.postMessage({ type:'EDUSEND_UPDATED', version:'2.8.0' })))
  );
});

async function refreshInBackground(req, cacheKey=req){
  try{
    const res=await fetch(req,{cache:'no-store'});
    if(res&&res.ok){const cache=await caches.open(CACHE);await cache.put(cacheKey,res.clone());}
    return res;
  }catch{return null;}
}

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Application data is handled by IndexedDB in app.js. Never invent API responses here.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith((async()=>{
      const cached=(await caches.match('/index.html')) || (await caches.match('/'));
      const networkPromise=refreshInBackground(req,'/index.html');
      if(cached){event.waitUntil(networkPromise);return cached;}
      return (await networkPromise) || (await caches.match('/offline.html')) || new Response('Reportform ZM is offline. Connect once to activate this phone.',{headers:{'Content-Type':'text/plain'}});
    })());
    return;
  }

  event.respondWith((async()=>{
    const cached=await caches.match(req);
    if(cached){event.waitUntil(refreshInBackground(req));return cached;}
    const res=await refreshInBackground(req);
    return res || new Response('',{status:503,statusText:'Offline'});
  })());
});

// Background Sync is not available in every browser. When supported, ask any open
// EduSend window to flush its IndexedDB outbox. The app also flushes on startup and
// on the normal online event, so offline saving does not depend on this API.
self.addEventListener('sync', event => {
  if(event.tag==='edusend-sync-results'){
    event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{
      clients.forEach(c=>c.postMessage({type:'EDUSEND_SYNC_REQUEST'}));
    }));
  }
});
