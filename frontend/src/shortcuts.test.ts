import { describe, expect, it } from "vitest";
import { chordLabel, type KeyPress, matchShortcut, SHORTCUTS } from "./shortcuts";

const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("matching a key press to a shortcut", () => {
  it("takes Cmd on a Mac and Ctrl elsewhere", () => {
    expect(matchShortcut(press("Enter", { metaKey: true }), true)).toBe("runSample");
    expect(matchShortcut(press("Enter", { ctrlKey: true }), false)).toBe("runSample");
    // Ctrl on a Mac is for talking, and for Helix's keys.
    expect(matchShortcut(press("Enter", { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(press("Enter", { metaKey: true }), false)).toBeNull();
  });

  it("needs exactly the chord's modifiers", () => {
    expect(matchShortcut(press("Enter"), true)).toBeNull();
    expect(matchShortcut(press("Enter", { metaKey: true, shiftKey: true }), true)).toBe("runReal");
    expect(matchShortcut(press("Enter", { metaKey: true, altKey: true }), true)).toBeNull();
    expect(matchShortcut(press("F8"), false)).toBe("nextProblem");
    expect(matchShortcut(press("F8", { shiftKey: true }), false)).toBe("previousProblem");
    expect(matchShortcut(press("Period", { metaKey: true, ctrlKey: true }), true)).toBeNull();
  });

  it("goes by where a key is, whatever Alt makes it type", () => {
    expect(matchShortcut(press("BracketRight", { altKey: true }), true)).toBe("nextTab");
    expect(matchShortcut(press("BracketLeft", { altKey: true }), false)).toBe("previousTab");
  });

  it("has no two shortcuts on one chord", () => {
    const chords = SHORTCUTS.map(({ chord }) =>
      [chord.code, chord.mod ?? false, chord.shift ?? false, chord.alt ?? false].join(),
    );
    expect(new Set(chords).size).toBe(chords.length);
  });
});

describe("a chord's label", () => {
  it("is written as its platform writes them", () => {
    const chord = { mod: true, shift: true, code: "Enter", name: "Enter" };
    expect(chordLabel(chord, true)).toBe("⌘⇧Enter");
    expect(chordLabel(chord, false)).toBe("Ctrl+Shift+Enter");
    expect(chordLabel({ alt: true, code: "BracketLeft", name: "[" }, true)).toBe("⌥[");
    expect(chordLabel({ code: "F8", name: "F8" }, false)).toBe("F8");
  });
});
