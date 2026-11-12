// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-view's input.rs, which reads
// and writes keys in the notation Helix's config uses, such as `A-x`, `C-S-left` and `ret`.

/**
 * A key, written as Helix writes it: modifiers in the order `Meta-S-A-C-`, then the key. A
 * character carries its shift itself (`X`, never `S-x`), so equal keys are equal strings.
 */
export type Key = string & { readonly __key: unique symbol };

export interface ParsedKey {
  /** A single character, or the name of a key that isn't one, such as `ret`. */
  readonly code: string;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

/** The names of keys that aren't characters, as Helix spells them. */
const NAMED = new Set([
  "backspace",
  "ret",
  "left",
  "right",
  "up",
  "down",
  "home",
  "end",
  "pageup",
  "pagedown",
  "tab",
  "del",
  "ins",
  "null",
  "esc",
  "capslock",
  "scrolllock",
  "numlock",
  "printscreen",
  "pause",
  "menu",
  "keypadbegin",
]);

/** Characters that have a name, which is how they're written. */
const CHAR_NAMES: Record<string, string> = { " ": "space", "-": "minus", "<": "lt", ">": "gt" };
const NAMED_CHARS: Record<string, string> = { space: " ", minus: "-", lt: "<", gt: ">" };

export function formatKey(key: ParsedKey): Key {
  let code = key.code;
  let shift = key.shift;
  if ([...code].length === 1) {
    // Characters never carry shift.
    shift = false;
    code = CHAR_NAMES[code] ?? code;
  }
  return `${key.meta ? "Meta-" : ""}${shift ? "S-" : ""}${key.alt ? "A-" : ""}${key.ctrl ? "C-" : ""}${code}` as Key;
}

export class KeyError extends Error {}

/** Reads a key in Helix's notation, such as `A-S-h`, which is the same key as `A-H`. */
export function parseKey(s: string): Key {
  if (s === "-")
    return formatKey({ code: "-", meta: false, shift: false, alt: false, ctrl: false });
  const tokens = s.split("-");
  const last = tokens.pop();
  if (last === undefined || last === "") {
    if (s.endsWith("-") && tokens[tokens.length - 1] === "") {
      throw new KeyError(
        `Key '-' cannot be used with modifiers, use '${s.replace(/-+$/, "")}-minus' instead`,
      );
    }
    throw new KeyError(`Missing key code in '${s}'`);
  }
  let code: string;
  if (NAMED.has(last)) {
    code = last;
  } else if (NAMED_CHARS[last] !== undefined) {
    code = NAMED_CHARS[last];
  } else if ([...last].length === 1) {
    code = last;
  } else if (/^F\d+$/.test(last)) {
    const n = Number(last.slice(1));
    if (n < 1 || n > 24) throw new KeyError(`Invalid function key '${last}'`);
    code = last;
  } else {
    throw new KeyError(`Invalid key code '${last}' in '${s}'`);
  }
  const mods = { meta: false, shift: false, alt: false, ctrl: false };
  for (const token of tokens) {
    const flag =
      token === "S"
        ? "shift"
        : token === "A"
          ? "alt"
          : token === "C"
            ? "ctrl"
            : token === "Meta" || token === "Cmd" || token === "Win"
              ? "meta"
              : null;
    if (flag === null) throw new KeyError(`Invalid key modifier '${token}-' in '${s}'`);
    if (mods[flag]) throw new KeyError(`Repeated key modifier '${token}-' in '${s}'`);
    mods[flag] = true;
  }
  // `C-S-r` and `C-R` are the same key.
  if (mods.shift && /^[a-z]$/.test(code)) {
    code = code.toUpperCase();
    mods.shift = false;
  }
  return formatKey({ code, ...mods });
}

export function unparseKey(key: Key): ParsedKey {
  let rest: string = key;
  const mods = { meta: false, shift: false, alt: false, ctrl: false };
  for (const [prefix, flag] of [
    ["Meta-", "meta"],
    ["S-", "shift"],
    ["A-", "alt"],
    ["C-", "ctrl"],
  ] as const) {
    if (rest.startsWith(prefix) && rest.length > prefix.length) {
      mods[flag] = true;
      rest = rest.slice(prefix.length);
    }
  }
  return { code: NAMED_CHARS[rest] ?? rest, ...mods };
}

/** The character a key types, if it's a character with no modifiers but shift. */
export function keyChar(key: Key): string | null {
  const parsed = unparseKey(key);
  if (parsed.alt || parsed.ctrl || parsed.meta) return null;
  return [...parsed.code].length === 1 ? parsed.code : null;
}

/** Like `keyChar`, but also for keys with modifiers, as Helix's `KeyEvent::char` is. */
export function keyCharWithModifiers(key: Key): string | null {
  const code = unparseKey(key).code;
  return [...code].length === 1 ? code : null;
}

export const KEY = {
  esc: "esc" as Key,
  ret: "ret" as Key,
  tab: "tab" as Key,
  backspace: "backspace" as Key,
};

/**
 * Reads keys written one after another, as macros are: single characters, and longer keys in
 * angle brackets, such as `ihello<esc>`.
 */
export function parseMacro(s: string): Key[] {
  const keys: Key[] = [];
  const chars = [...s];
  for (let i = 0; i < chars.length; ) {
    const c = at(chars, i);
    if (c === ">") throw new KeyError("Unmatched '>'");
    if (c !== "<") {
      keys.push(parseKey(c === "-" ? "minus" : c));
      i++;
      continue;
    }
    const end = chars.indexOf(">", i);
    if (end === -1) throw new KeyError("'>' expected");
    keys.push(parseKey(chars.slice(i + 1, end).join("")));
    i = end + 1;
  }
  return keys;
}

/** Writes keys as a macro that `parseMacro` reads back. */
export function formatMacro(keys: readonly Key[]): string {
  return keys.map((k) => ([...k].length === 1 ? k : `<${k}>`)).join("");
}

import { at } from "./text";

/** The keys produced by holding shift on a US keyboard, by the key's `KeyboardEvent.code`. */
const US_KEYS: Record<string, [string, string]> = {
  Backquote: ["`", "~"],
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
  Digit0: ["0", ")"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Space: [" ", " "],
};

/** The character shift makes of each character on a US keyboard, such as `@` for `2`. */
export const US_SHIFTED: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(US_KEYS),
);

const DOM_NAMED: Record<string, string> = {
  Backspace: "backspace",
  Enter: "ret",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Tab: "tab",
  Delete: "del",
  Insert: "ins",
  Escape: "esc",
  CapsLock: "capslock",
  ScrollLock: "scrolllock",
  NumLock: "numlock",
  PrintScreen: "printscreen",
  Pause: "pause",
  ContextMenu: "menu",
};

/** What the browser's key events have the key as, in the parts `keyFromEvent` reads. */
export interface DomKeyEvent {
  readonly key: string;
  readonly code: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
}

/**
 * The key a browser key event is, or null for one that isn't a key Helix knows, such as a
 * modifier pressed on its own or part of composing a character.
 */
export function keyFromEvent(event: DomKeyEvent): Key | null {
  if (event.isComposing || event.key === "Unidentified") return null;
  // Option with some keys on a Mac, such as `u` and `e`, starts composing an accented character.
  if (event.key === "Dead" && !(event.altKey || event.ctrlKey)) return null;
  if (["Shift", "Control", "Alt", "Meta", "AltGraph", "OS", "Hyper", "Super"].includes(event.key)) {
    return null;
  }
  const mods = {
    meta: event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
  };
  const named = DOM_NAMED[event.key] ?? (/^F\d{1,2}$/.test(event.key) ? event.key : undefined);
  if (named !== undefined) return formatKey({ code: named, ...mods });

  let ch = event.key;
  // On a Mac, Option changes the character typed (Option-x types ≈), so Alt keys are read from
  // where the key is instead, as on a US keyboard. Ctrl with a letter can also come through as a
  // control character.
  if ((event.altKey || event.ctrlKey) && (ch === "Dead" || !isPlainAscii(ch))) {
    const fromCode = charFromCode(event.code, event.shiftKey);
    if (fromCode !== null) ch = fromCode;
  }
  if ([...ch].length !== 1) return null;
  return formatKey({ code: ch, ...mods });
}

function isPlainAscii(ch: string): boolean {
  return ch.length === 1 && ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) < 0x7f;
}

function charFromCode(code: string, shift: boolean): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  const l = letter?.[1];
  if (l !== undefined) return shift ? l : l.toLowerCase();
  const key = US_KEYS[code];
  return key ? key[shift ? 1 : 0] : null;
}
