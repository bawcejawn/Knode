/* Knode service worker: makes the site installable and lets the page shell open without a connection.
   It only ever keeps the site's own page files. Game data (game-data/), the contract ABI, chain reads (RPC) and
   anything from another site always go straight to the network and are never stored here. Every page file is
   fetched fresh first; the stored copy is only used when the network can't be reached. */
const CACHE = "knode-shell-v2";
const SHELL = ["./", "index.html", "styles.css", "app.js", "wallet.js", "demo-data.js", "get.html", "get.js", "manifest.webmanifest", "media/icon.svg", "media/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  // Only this site's own page files: not game data, not the ABI, not other sites (RPC, fonts, wallet scripts).
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname) || url.search) return;
  const rel = url.pathname.slice(scope.pathname.length) || "./";
  if (!SHELL.includes(rel)) return;
  e.respondWith(fetch(req, { cache: "no-cache" }).then((res) => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("./") : Response.error()))));
});
