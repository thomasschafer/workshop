import { clampCodeScale } from "./zoom";

/** A setting kept on this device only, such as one that suits a phone but not a desk. */
export class DevicePreference<T extends string | boolean | number> {
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

/** How much the code editor's text is scaled from its usual size, by pinching or in settings. */
export const codeScale = new DevicePreference<number>("workshop:code-scale", 1, (stored) => {
  const scale = Number(stored);
  return stored.trim() !== "" && Number.isFinite(scale) ? clampCodeScale(scale) : null;
});

/**
 * The code editor's keybindings on this device, as a phone and a computer with a keyboard want
 * different ones; `config` follows the config file.
 */
export const KEYBINDINGS_CHOICES = ["config", "default", "helix"] as const;
export type KeybindingsChoice = (typeof KEYBINDINGS_CHOICES)[number];
export const keybindings = choice<KeybindingsChoice>(
  "workshop:keybindings",
  KEYBINDINGS_CHOICES,
  "config",
);

/**
 * How what's said is heard: Whisper on the server or the browser's own speech recognition while
 * the button is held, or the keyboard's dictation into a box. `auto` picks the best available.
 */
export const DICTATION_CHOICES = ["auto", "server", "browser", "keyboard"] as const;
export type DictationChoice = (typeof DICTATION_CHOICES)[number];
export const dictation = choice<DictationChoice>("workshop:dictation", DICTATION_CHOICES, "auto");

/** The last day's puzzle offered on opening the app, as `year-day`, so it's offered only once. */
export const puzzleOffered = new DevicePreference<string>("workshop:puzzle-offered", "", (s) => s);
