// Workshop's own on-screen keyboard, for Helix's keybindings on a touch screen: a laptop's keys,
// as a phone's keyboard has no Escape, Ctrl or Alt, and makes symbols hard to reach.

import { formatKey, type Key, US_SHIFTED } from "./helix/keys";

export type Modifier = "shift" | "ctrl" | "alt";

export type KeyDef =
  /** A key that types a character, such as `a` or `[`, which shift changes as on a US keyboard. */
  | { kind: "char"; char: string; label?: string; name?: string; width?: number }
  /** A key that isn't a character, in Helix's notation, such as `esc`. */
  | { kind: "named"; key: string; label: string; name: string; width?: number }
  | { kind: "modifier"; modifier: Modifier; label: string; name: string; width?: number };

export interface Row {
  readonly keys: readonly KeyDef[];
  /** How far in the row starts and ends, in columns, as the middle row of letters does. */
  readonly inset?: number;
  /** The letters, and the row beneath them, are as big as on a phone's keyboard; others smaller. */
  readonly size: "full" | "small";
}

/** Every row is this many columns wide; a key's width, if not 1, is in columns too. */
export const COLUMNS = 10;

const chars = (s: string): KeyDef[] => [...s].map((char) => ({ kind: "char", char }));

/**
 * The keys, row by row, a US laptop's, with the letters as a phone's keyboard has them: rows of
 * ten, nine set in by half a key, and seven between shift and backspace, so they're where the
 * thumbs expect them. The laptop's other keys are in two rows above, and the row below.
 */
export const LAYOUT: readonly Row[] = [
  {
    size: "small",
    keys: [
      { kind: "named", key: "esc", label: "esc", name: "Escape" },
      { kind: "named", key: "tab", label: "tab", name: "Tab" },
      ...chars("`-=[]\\;'"),
    ],
  },
  { size: "small", keys: chars("1234567890") },
  { size: "full", keys: chars("qwertyuiop") },
  { size: "full", inset: 0.5, keys: chars("asdfghjkl") },
  {
    size: "full",
    keys: [
      { kind: "modifier", modifier: "shift", label: "⇧", name: "Shift", width: 1.5 },
      ...chars("zxcvbnm"),
      { kind: "named", key: "backspace", label: "⌫", name: "Backspace", width: 1.5 },
    ],
  },
  {
    size: "full",
    keys: [
      { kind: "modifier", modifier: "ctrl", label: "ctrl", name: "Ctrl" },
      { kind: "modifier", modifier: "alt", label: "alt", name: "Alt" },
      { kind: "char", char: "," },
      { kind: "char", char: " ", label: "space", name: "Space", width: 3.5 },
      ...chars("./"),
      { kind: "named", key: "ret", label: "⏎", name: "Enter", width: 1.5 },
    ],
  },
];

/** A key's width, in columns. */
export function widthOf(def: KeyDef): number {
  return def.width ?? 1;
}

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

/** How soon a modifier has to be tapped again to lock it on, in milliseconds. */
export const DOUBLE_TAP_MS = 300;

/**
 * Shift, Ctrl and Alt, which work as on a laptop when held, and as one-shot keys when tapped: a
 * tap applies the modifier to the next key, and tapping again before then cancels it. Tapped
 * twice quickly, as on a phone's keyboard, a modifier locks on for every key until it's tapped
 * again.
 */
export class ModifierState {
  private readonly armed = new Set<Modifier>();
  private readonly locked = new Set<Modifier>();
  /** When each modifier was last pressed, to tell a double tap. */
  private readonly pressedAt = new Map<Modifier, number>();
  /** The modifiers held down, when each was pressed, and whether a key's been pressed since. */
  private readonly held = new Map<
    Modifier,
    { used: boolean; at: number; previous: number | undefined }
  >();

  /** Presses a modifier at `now`, in milliseconds. */
  press(modifier: Modifier, now: number): void {
    this.held.set(modifier, { used: false, at: now, previous: this.pressedAt.get(modifier) });
    this.pressedAt.set(modifier, now);
  }

  /** Lets go of a modifier, which was a tap, toggling it for the next key, if nothing used it. */
  release(modifier: Modifier): void {
    const hold = this.held.get(modifier);
    if (hold === undefined) return;
    this.held.delete(modifier);
    if (hold.used) return;
    if (this.locked.delete(modifier)) return;
    if (!this.armed.has(modifier)) {
      this.armed.add(modifier);
      return;
    }
    this.armed.delete(modifier);
    if (hold.previous !== undefined && hold.at - hold.previous <= DOUBLE_TAP_MS) {
      this.locked.add(modifier);
    }
  }

  /** The modifiers on now, which shows on their keys. */
  get current(): Modifiers {
    const on = (m: Modifier) => this.armed.has(m) || this.held.has(m) || this.locked.has(m);
    return { shift: on("shift"), ctrl: on("ctrl"), alt: on("alt") };
  }

  /** The modifiers locked on, rather than on for the next key alone. */
  get locks(): Modifiers {
    const on = (m: Modifier) => this.locked.has(m);
    return { shift: on("shift"), ctrl: on("ctrl"), alt: on("alt") };
  }

  /**
   * The modifiers for a key pressed now, which uses up those tapped and marks those held, so a
   * tap that follows isn't taken as the second of a double tap.
   */
  use(): Modifiers {
    const mods = this.current;
    this.armed.clear();
    this.pressedAt.clear();
    for (const hold of this.held.values()) hold.used = true;
    return mods;
  }
}

/** Whether holding a key down presses it again and again, as all but the modifiers do. */
export function repeats(def: KeyDef): def is KeyDef & { kind: "char" | "named" } {
  return def.kind !== "modifier";
}

/** Helix's movement keys, tinted so a finger finds its way back to them. */
export function movesCursor(def: KeyDef): boolean {
  return def.kind === "char" && "hjkl".includes(def.char);
}

/** Identifies a key within the layout. */
export function keyId(def: KeyDef): string {
  return def.kind === "char" ? def.char : def.name;
}

/** How long a key's held before it repeats, and then how often it does, in milliseconds. */
export const REPEAT_DELAY = 400;
export const REPEAT_INTERVAL = 33;
