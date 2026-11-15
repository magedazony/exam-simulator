// Service worker for the candidate app.
//
// Keeps the app shell (the page and its icons) so the app opens without a
// connection and starts fast. It never stores API responses: answers, results
// and personal data always come from the server, and a stale exam state can
// never be shown. The server replaces __VERSION__ with a hash of the page, so
// a new release installs a new worker and clears the old cache.
const VERSION = "__VERSION__";
const CACHE = "shell-" + VERSION;
const SHELL = ["/app", "/app/manifest.webmanifest", "/assets/icon-192.png", "/assets/icon-512.png", "/assets/icon-maskable-512.png", "/assets/favicon-32.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return; // network only
  if (req.mode === "navigate" && url.pathname.startsWith("/app")) {
    // Newest page when online; the saved shell when offline.
    event.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put("/app", res.clone())); return res; })
        .catch(() => caches.match("/app")),
    );
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((hit) => hit || fetch(req)));
  }
});
