/** A setting kept on this device only, such as one that suits a phone but not a desk. */
export class DevicePreference<T extends string | boolean> {
  constructor(
    private readonly key: string,
    private readonly fallback: T,
    /** Reads a stored value, or null if it isn't one this setting can take. */
    private readonly parse: (stored: string) => T | null,
  ) {}

  get(): T {
    try {
      const stored = localStorage.getItem(this.key);
      return (stored === null ? null : this.parse(stored)) ?? this.fallback;
    } catch {
      return this.fallback;
    }
  }

  set(value: T): void {
    try {
      localStorage.setItem(this.key, String(value));
    } catch {
      // Storage can be full or disabled; the setting still applies until the page reloads.
    }
  }
}

function flag(key: string, fallback: boolean): DevicePreference<boolean> {
  return new DevicePreference(key, fallback, (stored) =>
    stored === "true" ? true : stored === "false" ? false : null,
  );
}

function choice<T extends string>(key: string, choices: readonly T[], fallback: T) {
  return new DevicePreference<T>(
    key,
    fallback,
    (stored) => choices.find((c) => c === stored) ?? null,
  );
}

export const keepScreenOn = flag("workshop:keep-screen-on", true);
export const lineWrapping = flag("workshop:line-wrapping", false);

/**
 * How what's said is heard: the browser's own speech recognition while the button is held, or
 * the keyboard's dictation into a box. `auto` picks the best this device supports.
 */
export const DICTATION_CHOICES = ["auto", "browser", "keyboard"] as const;
export type DictationChoice = (typeof DICTATION_CHOICES)[number];
export const dictation = choice<DictationChoice>("workshop:dictation", DICTATION_CHOICES, "auto");
