import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  DOUBLE_TAP_MS,
  type KeyDef,
  keyFor,
  LAYOUT,
  labelFor,
  ModifierState,
  type Modifiers,
  movesCursor,
  NO_MODIFIERS,
  widthOf,
} from "./keyboard";

const char = (c: string): KeyDef & { kind: "char" } => ({ kind: "char", char: c });
const named = (key: string): KeyDef & { kind: "named" } => ({
  kind: "named",
  key,
  label: key,
  name: key,
});
const mods = (m: Partial<Modifiers>): Modifiers => ({ ...NO_MODIFIERS, ...m });

describe("the layout", () => {
  const keys = LAYOUT.flatMap((row) => row.keys);

  it("fills every row's columns", () => {
    for (const row of LAYOUT) {
      const used = row.keys.reduce((n, def) => n + widthOf(def), 2 * (row.inset ?? 0));
      expect(used).toBe(COLUMNS);
    }
  });

  it("has each key once", () => {
    const names = keys.map((def) => (def.kind === "char" ? def.char : def.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("has the letters where a phone's keyboard has them", () => {
    const letters = LAYOUT.map((row) => {
      let column = row.inset ?? 0;
      const placed: string[] = [];
      for (const def of row.keys) {
        if (def.kind === "char" && /^[a-z]$/.test(def.char)) placed.push(`${def.char}@${column}`);
        column += widthOf(def);
      }
      return placed.join(" ");
    }).filter((row) => row !== "");
    expect(letters).toEqual([
      "q@0 w@1 e@2 r@3 t@4 y@5 u@6 i@7 o@8 p@9",
      "a@0.5 s@1.5 d@2.5 f@3.5 g@4.5 h@5.5 j@6.5 k@7.5 l@8.5",
      "z@1.5 x@2.5 c@3.5 v@4.5 b@5.5 n@6.5 m@7.5",
    ]);
    const full = LAYOUT.filter((row) =>
      row.keys.some((def) => def.kind === "char" && /^[a-z]$/.test(def.char)),
    );
    expect(full.every((row) => row.size === "full")).toBe(true);
  });
});

describe("keyFor", () => {
  it.each([
    [char("a"), NO_MODIFIERS, "a"],
    [char("a"), mods({ shift: true }), "A"],
    [char("2"), mods({ shift: true }), "@"],
    [char("9"), mods({ shift: true }), "("],
    [char("["), mods({ shift: true }), "{"],
    [char("-"), NO_MODIFIERS, "minus"],
    [char("-"), mods({ shift: true }), "_"],
    [char(","), mods({ shift: true }), "lt"],
    [char("."), mods({ shift: true }), "gt"],
    [char(" "), NO_MODIFIERS, "space"],
    [char(" "), mods({ shift: true }), "space"],
    [char("x"), mods({ alt: true }), "A-x"],
    [char("c"), mods({ ctrl: true }), "C-c"],
    [char("a"), mods({ ctrl: true, shift: true }), "C-A"],
    [char("w"), mods({ ctrl: true, alt: true }), "A-C-w"],
    [named("esc"), NO_MODIFIERS, "esc"],
    [named("tab"), mods({ shift: true }), "S-tab"],
    [named("backspace"), mods({ alt: true }), "A-backspace"],
    [named("left"), mods({ ctrl: true, shift: true }), "S-C-left"],
  ])("%o with %o is %s", (def, m, expected) => {
    expect(keyFor(def, m)).toBe(expected);
  });
});

describe("labelFor", () => {
  it("follows shift for characters", () => {
    expect(labelFor(char("q"), false)).toBe("q");
    expect(labelFor(char("q"), true)).toBe("Q");
    expect(labelFor(char("1"), true)).toBe("!");
    expect(labelFor(named("esc"), true)).toBe("esc");
  });
});

describe("movesCursor", () => {
  it("is h, j, k and l alone", () => {
    const moving = LAYOUT.flatMap((row) => row.keys).filter(movesCursor);
    expect(moving.map((def) => (def.kind === "char" ? def.char : def.name))).toEqual([
      "h",
      "j",
      "k",
      "l",
    ]);
  });
});

describe("ModifierState", () => {
  it("applies a tapped modifier to the next key only", () => {
    const state = new ModifierState();
    state.press("shift", 0);
    state.release("shift");
    expect(state.current.shift).toBe(true);
    expect(state.use().shift).toBe(true);
    expect(state.use().shift).toBe(false);
  });

  it("cancels a tapped modifier when tapped again, not quickly", () => {
    const state = new ModifierState();
    state.press("ctrl", 0);
    state.release("ctrl");
    state.press("ctrl", DOUBLE_TAP_MS + 1);
    state.release("ctrl");
    expect(state.current.ctrl).toBe(false);
    expect(state.use().ctrl).toBe(false);
  });

  it("locks a modifier on when it's tapped twice quickly, until it's tapped again", () => {
    const state = new ModifierState();
    state.press("shift", 0);
    state.release("shift");
    state.press("shift", DOUBLE_TAP_MS);
    state.release("shift");
    expect(state.locks.shift).toBe(true);
    expect(state.use().shift).toBe(true);
    expect(state.use().shift).toBe(true);
    // Held while locked, it stays locked once let go.
    state.press("shift", 5000);
    expect(state.use().shift).toBe(true);
    state.release("shift");
    expect(state.use().shift).toBe(true);
    state.press("shift", 6000);
    state.release("shift");
    expect(state.locks.shift).toBe(false);
    expect(state.use().shift).toBe(false);
  });

  it("doesn't take a tap after a key as the second of a double tap", () => {
    const state = new ModifierState();
    state.press("shift", 0);
    state.release("shift");
    expect(state.use().shift).toBe(true);
    state.press("shift", 100);
    state.release("shift");
    expect(state.locks.shift).toBe(false);
    expect(state.use().shift).toBe(true);
    expect(state.use().shift).toBe(false);
  });

  it("applies a held modifier to every key until it's let go, and not after", () => {
    const state = new ModifierState();
    state.press("shift", 0);
    expect(state.use().shift).toBe(true);
    expect(state.use().shift).toBe(true);
    state.release("shift");
    expect(state.current.shift).toBe(false);
    expect(state.use().shift).toBe(false);
  });

  it("combines held and tapped modifiers", () => {
    const state = new ModifierState();
    state.press("alt", 0);
    state.release("alt");
    state.press("ctrl", 0);
    expect(state.use()).toEqual({ shift: false, ctrl: true, alt: true });
    expect(state.use()).toEqual({ shift: false, ctrl: true, alt: false });
    state.release("ctrl");
    expect(state.use()).toEqual(NO_MODIFIERS);
  });

  it("ignores letting go of a modifier that wasn't pressed", () => {
    const state = new ModifierState();
    state.release("shift");
    expect(state.current).toEqual(NO_MODIFIERS);
  });
});
