const CACHE_NAME = "antfarm-rts-v1";
const CORE_ASSETS = [
  "/rts",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png"
];

function isStaticAsset(requestUrl) {
  if (requestUrl.origin !== self.location.origin) return false;
  if (requestUrl.pathname.startsWith("/rts-sprites/")) return true;
  return /\.(?:png|webp|svg|js|css|webmanifest)$/i.test(requestUrl.pathname);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const network = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put("/rts", network.clone()).catch(() => undefined);
        return network;
      } catch {
        const cachedShell = await caches.match("/rts");
        if (cachedShell) return cachedShell;
        return new Response("Offline. Open the app once while online to cache the RTS shell.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    })());
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      const networkPromise = fetch(request)
        .then((response) => {
          cache.put(request, response.clone()).catch(() => undefined);
          return response;
        })
        .catch(() => null);
      return cached || (await networkPromise) || fetch(request);
    })());
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
