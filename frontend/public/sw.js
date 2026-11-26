// Workshop's service worker: keeps the app shell on the device so it starts instantly on flaky
// connections and works offline, isolates optional on-device bundles into per-version caches,
// shows notifications when puzzles unlock, and opens the puzzle a notification is about.

const APP_CACHE = "workshop-app";
const ON_DEVICE_PREFIX = "/on-device/";
const ON_DEVICE_CACHE_PREFIX = "workshop-on-device-";

/** Injected at build time by Vite. */
const RELEASE = /*__RELEASE__*/ "dev";
const PRECACHE_ASSETS = /*__PRECACHE_ASSETS__*/ [];

/** Release-scoped shell key so an in-progress update never overwrites the running release's HTML
 * before every chunk of the new release has been cached. */
const SHELL_KEY = `/__shell__/${RELEASE}`;

/** Public PWA chrome files cached best-effort so cold offline launches never hang waiting on them. */
const PUBLIC_SHELL_ASSETS = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];
const PUBLIC_SHELL_SET = new Set(PUBLIC_SHELL_ASSETS);

/** Extra built asset slots kept beyond the current release, so open tabs on an earlier release can
 * still load their lazy chunks offline until reloaded. */
const MAX_EXTRA_ASSETS = 60;

/** How long bootstrap waits on the network when a cached copy is already ready. */
const NETWORK_TIMEOUT_MS = 1500;

/** Answers from a reverse proxy (such as `tailscale serve`) when Workshop itself isn't reachable. */
const UNREACHABLE = new Set([502, 503, 504]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      // Atomically precache every built chunk AND the matching HTML shell for this release.
      // If any required chunk fails on a flaky link, abort install so the currently active
      // service worker keeps serving its complete, self-consistent release offline.
      await Promise.all(
        PRECACHE_ASSETS.map(async (path) => {
          const existing = await cache.match(path, { ignoreVary: true });
          if (existing) return;
          const response = await fetch(path, { cache: "reload", credentials: "same-origin" });
          if (!response.ok || response.type !== "basic") {
            throw new Error(`failed to precache ${path} (${response.status})`);
          }
          await cache.put(path, response);
        }),
      );
      const shellResponse = await fetch("/", { cache: "reload", credentials: "same-origin" });
      if (!shellResponse.ok || shellResponse.type !== "basic") {
        throw new Error(`failed to precache app shell (${shellResponse.status})`);
      }
      await cache.put(SHELL_KEY, shellResponse.clone());
      await cache.put("/", shellResponse);

      // Best-effort warm of manifest, icons, and bootstrap so cold offline launches are instant.
      await Promise.allSettled(
        [...PUBLIC_SHELL_ASSETS, "/api/bootstrap"].map(async (path) => {
          const response = await fetch(path, { cache: "reload", credentials: "same-origin" });
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
    // Login links carry `?token=...` and must reach the server so it can set the auth cookie.
    if (url.searchParams.has("token")) return;
    // Serve this release's precached HTML shell immediately so cold launches on dead/VPN links
    // never hang on the Android PWA splash screen or mix HTML from one release with old chunks.
    event.respondWith(serveShell(request));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirstAsset(request));
  } else if (PUBLIC_SHELL_SET.has(url.pathname)) {
    event.respondWith(cacheFirstPublic(request, url.pathname));
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
 * Serves the precached HTML shell for this SW release immediately when present, avoiding splash
 * screen hangs on offline/blackholed VPN connections and preventing cross-release HTML/chunk skew.
 */
async function serveShell(request) {
  const cache = await caches.open(APP_CACHE);
  const kept =
    (await cache.match(SHELL_KEY, { ignoreVary: true })) ??
    (await cache.match("/", { ignoreVary: true }));
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    await cache.put(SHELL_KEY, response.clone());
    await cache.put("/", response.clone());
  }
  return response;
}

/**
 * Races the network against `timeoutMs` when a cached copy exists, so flaky connections don't
 * stall startup. Returns the cached copy immediately when the OS already reports offline.
 */
async function networkFirstWithTimeout(request, key, timeoutMs) {
  const cache = await caches.open(APP_CACHE);
  const kept = await cache.match(key);

  const staleResponse = () => {
    const copy = kept.clone();
    const headers = new Headers(copy.headers);
    headers.set("X-Workshop-Cache", "stale");
    return new Response(copy.body, {
      status: copy.status,
      statusText: copy.statusText,
      headers,
    });
  };

  if (kept && self.navigator && self.navigator.onLine === false) {
    return staleResponse();
  }

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
  const kept = await cache.match(request, { ignoreVary: true });
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    void pruneAssets();
  }
  return response;
}

async function cacheFirstPublic(request, key) {
  const cache = await caches.open(APP_CACHE);
  const kept = await cache.match(key, { ignoreVary: true });
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    await cache.put(key, response.clone());
  }
  return response;
}

/** Serves versioned on-device runtime bundles from their own dedicated cache, never pruned with
 * app assets. Writes happen only through the client bundle installer after SHA-256 verification. */
async function cacheFirstIn(cacheName, request) {
  const cache = await caches.open(cacheName);
  const kept = await cache.match(request);
  if (kept) return kept;
  return fetch(request);
}

/** Removes superseded shell entries and old `/assets/` entries beyond `MAX_EXTRA_ASSETS`. */
async function pruneAssets() {
  const cache = await caches.open(APP_CACHE);
  const current = new Set(PRECACHE_ASSETS);
  const keys = await cache.keys();
  const staleShells = keys.filter((req) => {
    const pathname = new URL(req.url).pathname;
    return pathname.startsWith("/__shell__/") && pathname !== SHELL_KEY;
  });
  const extras = keys.filter((req) => {
    const pathname = new URL(req.url).pathname;
    return pathname.startsWith("/assets/") && !current.has(pathname);
  });
  await Promise.all([
    ...staleShells.map((req) => cache.delete(req)),
    ...extras.slice(0, -MAX_EXTRA_ASSETS).map((req) => cache.delete(req)),
  ]);
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
