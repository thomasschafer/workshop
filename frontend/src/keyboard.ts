// Workshop's own on-screen keyboard, for Helix's keybindings on a touch screen: a laptop's keys,
// as a phone's keyboard has no Escape, Ctrl or Alt, and makes symbols hard to reach.

import { formatKey, type Key, US_SHIFTED } from "./helix/keys";

export type Modifier = "shift" | "ctrl" | "alt";

export type KeyDef =
  /** A key that types a character, such as `a` or `[`, which shift changes as on a US keyboard. */
  | { kind: "char"; char: string; label?: string; name?: string; width?: number }
  /** A key that isn't a character, in Helix's notation, such as `esc`. */
  | { kind: "named"; key: string; label: string; name: string; width?: number }
  | { kind: "modifier"; modifier: Modifier; label: string; name: string; width?: number }
  /** Lowers the keyboard. */
  | { kind: "lower"; label: string; name: string };

const chars = (s: string): KeyDef[] => [...s].map((char) => ({ kind: "char", char }));

/**
 * The keys, row by row, ten to a row as on a phone's keyboard: a US laptop's, with those at its
 * edges moved to a row along the top and to the bottom row.
 */
export const LAYOUT: readonly (readonly KeyDef[])[] = [
  [
    { kind: "named", key: "esc", label: "esc", name: "Escape" },
    { kind: "named", key: "tab", label: "tab", name: "Tab" },
    ...chars("`-=[]\\'"),
    { kind: "lower", label: "▾", name: "Hide keyboard" },
  ],
  chars("1234567890"),
  chars("qwertyuiop"),
  chars("asdfghjkl;"),
  [
    { kind: "modifier", modifier: "shift", label: "⇧", name: "Shift", width: 1.5 },
    ...chars("zxcvbnm"),
    { kind: "named", key: "backspace", label: "⌫", name: "Backspace", width: 1.5 },
  ],
  [
    { kind: "modifier", modifier: "ctrl", label: "ctrl", name: "Ctrl" },
    { kind: "modifier", modifier: "alt", label: "alt", name: "Alt" },
    { kind: "char", char: "," },
    { kind: "char", char: " ", label: "space", name: "Space", width: 3.5 },
    ...chars("./"),
    { kind: "named", key: "ret", label: "⏎", name: "Enter", width: 1.5 },
  ],
];

export interface Modifiers {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
}

export const NO_MODIFIERS: Modifiers = { shift: false, ctrl: false, alt: false };

/** The character a key types with shift as given. */
export function charFor(char: string, shift: boolean): string {
  if (!shift) return char;
  return US_SHIFTED[char] ?? char.toUpperCase();
}

/** The key, in Helix's notation, that pressing `def` with `mods` is. */
export function keyFor(def: KeyDef & { kind: "char" | "named" }, mods: Modifiers): Key {
  const common = { meta: false, alt: mods.alt, ctrl: mods.ctrl };
  return def.kind === "char"
    ? formatKey({ code: charFor(def.char, mods.shift), shift: false, ...common })
    : formatKey({ code: def.key, shift: mods.shift, ...common });
}

/** What a key shows, which for characters follows shift, as a phone's keyboard does. */
export function labelFor(def: KeyDef, shift: boolean): string {
  if (def.kind === "char") return def.label ?? charFor(def.char, shift);
  return def.label;
}

/**
 * Shift, Ctrl and Alt, which work as on a laptop when held, and as one-shot keys when tapped: a
 * tap applies the modifier to the next key, and tapping again before then cancels it.
 */
export class ModifierState {
  private readonly armed = new Set<Modifier>();
  /** The modifiers held down, and whether a key's been pressed with each since. */
  private readonly held = new Map<Modifier, { used: boolean }>();

  press(modifier: Modifier): void {
    this.held.set(modifier, { used: false });
  }

  /** Lets go of a modifier, which was a tap, toggling it for the next key, if nothing used it. */
  release(modifier: Modifier): void {
    const hold = this.held.get(modifier);
    if (hold === undefined) return;
    this.held.delete(modifier);
    if (hold.used) return;
    if (this.armed.has(modifier)) this.armed.delete(modifier);
    else this.armed.add(modifier);
  }

  /** The modifiers on now, which shows on their keys. */
  get current(): Modifiers {
    const on = (m: Modifier) => this.armed.has(m) || this.held.has(m);
    return { shift: on("shift"), ctrl: on("ctrl"), alt: on("alt") };
  }

  /** The modifiers for a key pressed now, which uses up those tapped and marks those held. */
  use(): Modifiers {
    const mods = this.current;
    this.armed.clear();
    for (const hold of this.held.values()) hold.used = true;
    return mods;
  }
}

/** Whether holding a key down presses it again and again, as all but the modifiers do. */
export function repeats(def: KeyDef): def is KeyDef & { kind: "char" | "named" } {
  return def.kind === "char" || def.kind === "named";
}

/** Identifies a key within the layout. */
export function keyId(def: KeyDef): string {
  return def.kind === "char" ? def.char : def.name;
}

/** How long a key's held before it repeats, and then how often it does, in milliseconds. */
export const REPEAT_DELAY = 400;
export const REPEAT_INTERVAL = 33;
