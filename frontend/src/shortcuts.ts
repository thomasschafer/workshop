// Keyboard shortcuts that work anywhere in the app, whichever keybindings the code has. They're
// chords with Cmd on a Mac and Ctrl elsewhere, or function keys, chosen to stay clear of what
// browsers keep for themselves and of the keys Helix binds.

export type ShortcutId =
  | "runSample"
  | "runReal"
  | "zen"
  | "nextTab"
  | "previousTab"
  | "save"
  | "nextProblem"
  | "previousProblem"
  | "shortcuts";

interface Chord {
  /** Cmd on a Mac, Ctrl elsewhere. */
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /**
   * The key's place on the keyboard, as `KeyboardEvent.code`, so a chord with Alt is the same key
   * whatever character Alt makes it type.
   */
  readonly code: string;
  /** What the key is called, for showing the chord. */
  readonly name: string;
}

export interface Shortcut {
  readonly id: ShortcutId;
  readonly chord: Chord;
  readonly description: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "runSample",
    chord: { mod: true, code: "Enter", name: "Enter" },
    description: "Run on the sample",
  },
  {
    id: "runReal",
    chord: { mod: true, shift: true, code: "Enter", name: "Enter" },
    description: "Run on your input",
  },
  {
    id: "zen",
    chord: { mod: true, code: "Period", name: "." },
    description: "Enter or leave zen mode",
  },
  {
    id: "nextTab",
    chord: { alt: true, code: "BracketRight", name: "]" },
    description: "Turn to the next tab",
  },
  {
    id: "previousTab",
    chord: { alt: true, code: "BracketLeft", name: "[" },
    description: "Turn to the tab before",
  },
  { id: "save", chord: { mod: true, code: "KeyS", name: "S" }, description: "Save now" },
  { id: "nextProblem", chord: { code: "F8", name: "F8" }, description: "Go to the next problem" },
  {
    id: "previousProblem",
    chord: { shift: true, code: "F8", name: "F8" },
    description: "Go to the problem before",
  },
  {
    id: "shortcuts",
    chord: { mod: true, shift: true, code: "Slash", name: "/" },
    description: "Show these shortcuts",
  },
];

/** The parts of a key press that say which chord it is. */
export interface KeyPress {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** The shortcut a key press is, if any. Modifiers must match exactly, so chords can't overlap. */
export function matchShortcut(press: KeyPress, mac: boolean): ShortcutId | null {
  const mod = mac ? press.metaKey : press.ctrlKey;
  // The other of Cmd and Ctrl makes it some other chord.
  const other = mac ? press.ctrlKey : press.metaKey;
  if (other) return null;
  const found = SHORTCUTS.find(
    ({ chord }) =>
      chord.code === press.code &&
      (chord.mod ?? false) === mod &&
      (chord.shift ?? false) === press.shiftKey &&
      (chord.alt ?? false) === press.altKey,
  );
  return found?.id ?? null;
}

/** A chord as it's written for its platform: `⌘⇧Enter` on a Mac, `Ctrl+Shift+Enter` elsewhere. */
export function chordLabel(chord: Chord, mac: boolean): string {
  if (mac) {
    return `${chord.mod ? "⌘" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.name}`;
  }
  return [chord.mod ? "Ctrl" : "", chord.alt ? "Alt" : "", chord.shift ? "Shift" : "", chord.name]
    .filter((part) => part !== "")
    .join("+");
}

/** Whether this is a Mac, an iPhone or an iPad, whose keyboards have Cmd for shortcuts. */
export function isApple(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}
