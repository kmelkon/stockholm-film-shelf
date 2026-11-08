// Filmhyllan service worker: same-origin only (covers from TMDb / the library are left to the browser).
// Page + films.json: network first so the nightly update shows right away, cache as offline fallback.
// Fonts + icons: cache first (they never change without a new VERSION).
const VERSION = 'v2';
const SHELL = ['./', 'index.html', 'fonts/fonts.css', 'manifest.webmanifest', 'img/icon.svg', 'img/tmdb.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const static_ = /\/(fonts|img)\//.test(url.pathname);
  e.respondWith(static_ ? cacheFirst(req) : networkFirst(req));
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  return hit || put(req, await fetch(req));
}

async function networkFirst(req) {
  try {
    return await put(req, await fetch(req));
  } catch {
    return (await caches.match(req, { ignoreSearch: true })) || Response.error();
  }
}

async function put(req, res) {
  if (res.ok) { const c = await caches.open(VERSION); c.put(req, res.clone()); }
  return res;
}
