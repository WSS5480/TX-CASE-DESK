// TX Case Desk service worker: makes the app installable and opens the last-loaded screens offline.
// Always tries the network first so new versions load right away; private data (/api, payments, portal) is never cached.
const CACHE = "tcd-shell-v1";
const SHELL = ["/", "/app.js", "/practice.js", "/manifest.json", "/icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (/^\/(api|cal|pay|portal|export|invoice)\b/.test(u.pathname)) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok && SHELL.includes(u.pathname)) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(u.pathname, copy)); } return r; })
    .catch(() => caches.match(u.pathname).then(m => m || caches.match("/"))));
});
