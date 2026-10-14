import type { DictationChoice } from "./preferences";

/** How what's said reaches Workshop on this device. */
export type DictationMethod =
  /** Recorded while the button is held, and heard by Whisper on the server. */
  | "server"
  /** The browser's own speech recognition, while the button is held. */
  | "browser"
  /** The keyboard's dictation, into a box the button opens. Works on any phone. */
  | "keyboard";

/** The methods that hold the button to talk. */
export type HoldMethod = Exclude<DictationMethod, "keyboard">;

/** What this device and the server can do. */
export interface DictationSupport {
  /** Whisper is ready on the server, and this browser can record. */
  server: boolean;
  /** This browser has speech recognition of its own. */
  browser: boolean;
}

/**
 * The method to use: the one chosen if it's available, otherwise the best that is. Whisper hears
 * code most accurately, then the browser's recognition; the keyboard works everywhere.
 */
export function resolveDictation(
  choice: DictationChoice,
  support: DictationSupport,
): DictationMethod {
  if (choice === "keyboard") return "keyboard";
  if (choice === "browser" && support.browser) return "browser";
  if (support.server) return "server";
  if (support.browser) return "browser";
  return "keyboard";
}
