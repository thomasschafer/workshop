/** A setting kept on this device only, such as one that suits a phone but not a desk. */
export class DevicePreference {
  constructor(
    private readonly key: string,
    private readonly fallback: boolean,
  ) {}

  get(): boolean {
    try {
      const stored = localStorage.getItem(this.key);
      return stored === null ? this.fallback : stored === "true";
    } catch {
      return this.fallback;
    }
  }

  set(enabled: boolean): void {
    try {
      localStorage.setItem(this.key, String(enabled));
    } catch {
      // Storage can be full or disabled; the setting still applies until the page reloads.
    }
  }
}

export const keepScreenOn = new DevicePreference("workshop:keep-screen-on", true);
export const lineWrapping = new DevicePreference("workshop:line-wrapping", false);
