import type { Bootstrap, UiState } from "../api";

const BOOTSTRAP_STORAGE_KEY = "workshop:bootstrap";

/** Reads the last known bootstrap payload from localStorage, returning null if missing or corrupt. */
export function readCachedBootstrap(): Bootstrap | null {
  try {
    const raw = localStorage.getItem(BOOTSTRAP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Bootstrap> | null;
    if (parsed && typeof parsed === "object" && parsed.language && parsed.editor && parsed.state) {
      return parsed as Bootstrap;
    }
    return null;
  } catch {
    return null;
  }
}

/** Saves a fresh bootstrap payload for instant cold starts when offline or on a stalled link. */
export function writeCachedBootstrap(boot: Bootstrap): void {
  try {
    localStorage.setItem(BOOTSTRAP_STORAGE_KEY, JSON.stringify(boot));
  } catch {
    // Storage may be full or disabled; the service worker cache still serves bootstrap offline.
  }
}

/** Keeps the cached bootstrap's UI state in sync so an offline cold start reopens the active puzzle. */
export function patchCachedBootstrapState(state: UiState): void {
  const cached = readCachedBootstrap();
  if (!cached) return;
  writeCachedBootstrap({ ...cached, state });
}
