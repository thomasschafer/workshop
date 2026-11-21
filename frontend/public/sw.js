// Workshop's service worker: keeps the app shell on the device so it starts quickly on flaky
// connections and works offline, isolates optional on-device bundles into per-version caches,
// shows notifications when puzzles unlock, and opens the puzzle a notification is about.

const APP_CACHE = "workshop-app";
const ON_DEVICE_PREFIX = "/on-device/";
const ON_DEVICE_CACHE_PREFIX = "workshop-on-device-";

/** Injected at build time by Vite. */
const RELEASE = /*__RELEASE__*/ "dev";
const PRECACHE_ASSETS = /*__PRECACHE_ASSETS__*/ [];

/** Extra built asset slots kept beyond the current release, so open tabs on an earlier release can
 * still load their lazy chunks offline until reloaded. */
const MAX_EXTRA_ASSETS = 60;

/** How long navigation and bootstrap wait on the network when a cached copy is already ready. */
const NETWORK_TIMEOUT_MS = 1500;

/** Answers from a reverse proxy (such as `tailscale serve`) when Workshop itself isn't reachable. */
const UNREACHABLE = new Set([502, 503, 504]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      // Precache every built chunk of this release without evicting the previous release's chunks.
      await Promise.allSettled(
        ["/", ...PRECACHE_ASSETS].map(async (path) => {
          const existing = path.startsWith("/assets/") ? await cache.match(path) : null;
          if (existing) return;
          const response = await fetch(path, { cache: "reload" });
          if (response.ok && response.type === "basic") {
            await cache.put(path, response);
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await pruneAssets();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith(ON_DEVICE_PREFIX)) {
    const bundle = bundleId(url.pathname);
    if (bundle) {
      event.respondWith(cacheFirstIn(`${ON_DEVICE_CACHE_PREFIX}${bundle}`, request));
    }
    return;
  }

  if (request.mode === "navigate") {
    // Every address is the same page, which reads the address itself.
    event.respondWith(networkFirstWithTimeout(request, "/", NETWORK_TIMEOUT_MS));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirstAsset(request));
  } else if (url.pathname === "/api/bootstrap") {
    // Never stale-while-revalidate: wait briefly for fresh UI state, falling back to cache when
    // offline or on a stalled link.
    event.respondWith(networkFirstWithTimeout(request, "/api/bootstrap", NETWORK_TIMEOUT_MS));
  }
});

/** Extracts `<bundle>@<version>` from `/on-device/<bundle>@<version>/...`. */
function bundleId(pathname) {
  const rest = pathname.slice(ON_DEVICE_PREFIX.length);
  const slash = rest.indexOf("/");
  const segment = slash === -1 ? rest : rest.slice(0, slash);
  return segment.includes("@") ? segment : null;
}

/**
 * Races the network against `timeoutMs` when a cached copy exists, so flaky connections don't
 * stall startup. When no cache exists yet, waits for the network.
 */
async function networkFirstWithTimeout(request, key, timeoutMs) {
  const cache = await caches.open(APP_CACHE);
  const kept = await cache.match(key);

  const network = fetch(request).then(
    async (response) => {
      if (UNREACHABLE.has(response.status)) {
        throw new Error(`unreachable (${response.status})`);
      }
      if (response.ok && response.type === "basic") {
        await cache.put(key, response.clone());
      }
      return response;
    },
    (error) => {
      throw error;
    },
  );

  if (!kept) return network;

  const staleResponse = () => {
    const headers = new Headers(kept.headers);
    headers.set("X-Workshop-Cache", "stale");
    return new Response(kept.body, {
      status: kept.status,
      statusText: kept.statusText,
      headers,
    });
  };

  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(staleResponse()), timeoutMs);
  });

  // Prevent unhandled rejections if the timeout wins and the background fetch later fails.
  network.catch(() => {});

  try {
    return await Promise.race([
      network.catch(() => staleResponse()),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Built files are content-hashed, so a cached copy is always valid. */
async function cacheFirstAsset(request) {
  const cache = await caches.open(APP_CACHE);
  const kept = await cache.match(request);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    void pruneAssets();
  }
  return response;
}

/** Serves versioned on-device runtime bundles from their own dedicated cache, never pruned with
 * app assets. */
async function cacheFirstIn(cacheName, request) {
  const cache = await caches.open(cacheName);
  const kept = await cache.match(request);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

/** Removes only old `/assets/` entries beyond the current release plus `MAX_EXTRA_ASSETS`. */
async function pruneAssets() {
  const cache = await caches.open(APP_CACHE);
  const current = new Set(PRECACHE_ASSETS);
  const extras = (await cache.keys()).filter((req) => {
    const pathname = new URL(req.url).pathname;
    return pathname.startsWith("/assets/") && !current.has(pathname);
  });
  await Promise.all(extras.slice(0, -MAX_EXTRA_ASSETS).map((req) => cache.delete(req)));
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "workshop:release") {
    event.ports[0]?.postMessage({ release: RELEASE, assets: PRECACHE_ASSETS.length });
  }
});

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
