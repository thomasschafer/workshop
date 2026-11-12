import { describe, expect, it } from "vitest";
import {
  type KeyDef,
  keyFor,
  LAYOUT,
  labelFor,
  ModifierState,
  type Modifiers,
  NO_MODIFIERS,
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
  it("has ten columns in every row", () => {
    for (const row of LAYOUT) {
      const columns = row.reduce(
        (n, def) => n + ("width" in def && def.width !== undefined ? def.width : 1),
        0,
      );
      expect(columns).toBe(10);
    }
  });

  it("has each key once", () => {
    const names = LAYOUT.flat().map((def) => (def.kind === "char" ? def.char : def.name));
    expect(new Set(names).size).toBe(names.length);
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

describe("ModifierState", () => {
  it("applies a tapped modifier to the next key only", () => {
    const state = new ModifierState();
    state.press("shift");
    state.release("shift");
    expect(state.current.shift).toBe(true);
    expect(state.use().shift).toBe(true);
    expect(state.use().shift).toBe(false);
  });

  it("cancels a tapped modifier when tapped again", () => {
    const state = new ModifierState();
    state.press("ctrl");
    state.release("ctrl");
    state.press("ctrl");
    state.release("ctrl");
    expect(state.current.ctrl).toBe(false);
  });

  it("applies a held modifier to every key until it's let go, and not after", () => {
    const state = new ModifierState();
    state.press("shift");
    expect(state.use().shift).toBe(true);
    expect(state.use().shift).toBe(true);
    state.release("shift");
    expect(state.current.shift).toBe(false);
    expect(state.use().shift).toBe(false);
  });

  it("combines held and tapped modifiers", () => {
    const state = new ModifierState();
    state.press("alt");
    state.release("alt");
    state.press("ctrl");
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
