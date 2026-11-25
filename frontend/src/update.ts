// Picking up a new release of the app. The service worker installs it in the background and takes
// over at once, but the page keeps running the release it loaded with until it's reloaded. So
// once a new one has taken over, the app offers to reload, and reloads by itself on being come
// back to, but only where the screen showing says nothing would be lost.

import { useEffect, useState } from "preact/hooks";

/** How long the app must have been out of sight before coming back to it reloads it. */
const RELOAD_AFTER_HIDDEN_MS = 30_000;

let ready = false;
const listeners = new Set<() => void>();

/**
 * Whether the screen showing says reloading now would lose nothing, as it would with a dictation
 * under way or an answer half typed. Null, where no screen has said, counts as unsafe, so a
 * screen that's never asked is never reloaded under the user.
 */
let safeToReload: boolean | null = null;

/** Starts watching for a new release; once, as the app starts. */
export function watchForUpdates(): void {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  // Without a controller this is the service worker's first install, not a newer release.
  const hadController = sw.controller !== null;
  sw.addEventListener("controllerchange", () => {
    if (!hadController || ready) return;
    ready = true;
    for (const listener of listeners) listener();
  });

  let hiddenAt: number | null = null;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (ready && away >= RELOAD_AFTER_HIDDEN_MS && safeToReload === true) {
      location.reload();
      return;
    }
    // A phone can keep the app open for days, so look for a newer release on coming back to it.
    sw.getRegistration()
      .then((registration) => registration?.update())
      .catch(() => {
        // Offline, most likely; the next time the app is come back to tries again.
      });
  });
}

/** Whether a new release has taken over, so reloading would show it. */
export function useUpdateReady(): boolean {
  const [shown, setShown] = useState(ready);
  useEffect(() => {
    const listener = () => setShown(true);
    listeners.add(listener);
    setShown(ready);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return shown;
}

/**
 * Says, while the calling screen is showing, whether reloading it now would lose nothing, so a
 * new release can be picked up by itself on coming back to the app.
 */
export function useReloadSafety(safe: boolean): void {
  useEffect(() => setReloadSafety(safe), [safe]);
  useEffect(() => () => setReloadSafety(null), []);
}

/** What `useReloadSafety` says for the screen showing, or null once it's gone. */
export function setReloadSafety(safe: boolean | null): void {
  safeToReload = safe;
}
