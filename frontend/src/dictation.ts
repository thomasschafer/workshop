import type { DictationChoice } from "./preferences";

/** How what's said reaches Workshop on this device. */
export type DictationMethod =
  /** The browser's own speech recognition, while the button is held. */
  | "browser"
  /** The keyboard's dictation, into a box the button opens. Works on any phone. */
  | "keyboard";

/** The method to use: the one chosen if this device supports it, otherwise the best it does. */
export function resolveDictation(choice: DictationChoice, browserSpeech: boolean): DictationMethod {
  if (choice === "keyboard" || !browserSpeech) return "keyboard";
  return "browser";
}
