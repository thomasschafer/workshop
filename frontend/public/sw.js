// Workshop's service worker: it keeps the app on the device so short items can be practised
// offline, shows notifications when puzzles unlock, and opens the puzzle a notification is about
// when it's tapped.

const CACHE = "workshop-app";

/** The most built files to keep, which is a few releases' worth. */
const MAX_ASSETS = 60;

/** What the app needs to start, kept as last fetched for when the server can't be reached. */
const STARTUP = new Set(["/api/bootstrap", "/api/home"]);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    // Every address is the same page, which reads the address itself.
    event.respondWith(networkFirst(request, "/"));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else if (STARTUP.has(url.pathname)) {
    event.respondWith(networkFirst(request, url.pathname));
  }
});

/** The server's answer, kept for later; or, when it can't be reached, the one kept last time. */
async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") await cache.put(key, response.clone());
    return response;
  } catch (error) {
    const kept = await cache.match(key);
    if (kept) return kept;
    throw error;
  }
}

/** Built files never change, as their names say what's in them, so a kept one is always right. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(request);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    const assets = (await cache.keys()).filter((r) =>
      new URL(r.url).pathname.startsWith("/assets/"),
    );
    // The oldest go first: they're from earlier releases.
    await Promise.all(assets.slice(0, -MAX_ASSETS).map((r) => cache.delete(r)));
  }
  return response;
}

self.addEventListener("push", (event) => {
  const message = event.data ? event.data.json() : { title: "Workshop", body: "", url: "/" };
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      icon: "/icon-192.png",
      data: { url: message.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // An open Workshop is brought forward and asked to open the puzzle, rather than a new one
      // opened beside it.
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        open.postMessage({ open: url });
        return open.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
