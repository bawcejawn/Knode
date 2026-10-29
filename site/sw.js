/* Retired: the site moved from /site/ to the top of knodegames.com. This replaces the old service worker for /site/,
   clears what it stored and removes itself, so old installs don't keep showing old pages. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    .then(() => self.registration.unregister())
    .then(() => self.clients.matchAll({ type: "window" }))
    .then((list) => list.forEach((c) => { if ("navigate" in c) c.navigate(c.url).catch(() => {}); })));
});
