const cacheName = "harbor-music-shell-standalone-2";
const shell = [
  "/music/", "/music/music.css", "/music/music.js", "/music/sharing.js",
  "/music/manifest.webmanifest", "/music/icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell.map(path => new Request(path, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith("harbor-music-shell-") && key !== cacheName)
      .map(key => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !shell.includes(url.pathname)) return;
  event.respondWith(caches.open(cacheName).then(async cache => {
    const saved = await cache.match(url.pathname);
    return saved || fetch(event.request);
  }));
});
