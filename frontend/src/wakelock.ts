// Keeps the screen on while Workshop is visible, so the phone doesn't sleep mid-puzzle.

interface WakeLockSentinel {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

interface WakeLockApi {
  request(type: "screen"): Promise<WakeLockSentinel>;
}

const STORAGE_KEY = "workshop:keep-screen-on";

export function keepScreenOnPreference(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== "false";
}

export function setKeepScreenOnPreference(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(enabled));
}

export function wakeLockSupported(): boolean {
  return "wakeLock" in navigator;
}

/** Holds a screen wake lock while enabled, re-acquiring it whenever the page becomes visible. */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private enabled = false;

  constructor() {
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      void this.acquire();
    } else {
      void this.sentinel?.release();
      this.sentinel = null;
    }
  }

  dispose(): void {
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.setEnabled(false);
  }

  private readonly onVisibility = () => {
    // Browsers release the lock whenever the page is hidden.
    if (document.visibilityState === "visible" && this.enabled) {
      void this.acquire();
    }
  };

  private async acquire(): Promise<void> {
    const api = (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock;
    if (!api || this.sentinel || document.visibilityState !== "visible") return;
    try {
      const sentinel = await api.request("screen");
      this.sentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (this.sentinel === sentinel) this.sentinel = null;
      });
    } catch {
      // Refused, for example in battery saver mode; the screen just sleeps as normal.
    }
  }
}
