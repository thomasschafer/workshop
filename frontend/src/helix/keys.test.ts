import { describe, expect, it } from "vitest";
import { infobox, keymapsWithConfig } from "./keymap";
import { formatMacro, keyFromEvent, parseKey, parseMacro } from "./keys";
import { harness } from "./testing";

const event = (
  key: string,
  code: string,
  mods: Partial<Record<"alt" | "ctrl" | "meta" | "shift", boolean>> = {},
) => ({
  key,
  code,
  altKey: mods.alt ?? false,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
});

describe("keys", () => {
  it("reads Helix's notation, with shift on characters folded in", () => {
    expect(parseKey("A-S-h")).toBe("A-H");
    expect(parseKey("C-S-r")).toBe(parseKey("C-R"));
    expect(parseKey("ret")).toBe("ret");
    expect(parseKey("S-tab")).toBe("S-tab");
    expect(parseKey("minus")).toBe(parseKey("-"));
    expect(() => parseKey("A--")).toThrow(/minus/);
    expect(() => parseKey("Q-x")).toThrow(/modifier/);
    expect(() => parseKey("nope")).toThrow(/key code/);
  });

  it("reads and writes macros", () => {
    const keys = parseMacro("ihello<esc><A-x>-");
    expect(keys).toEqual(["i", "h", "e", "l", "l", "o", "esc", "A-x", "minus"]);
    expect(formatMacro(keys)).toBe("ihello<esc><A-x><minus>");
  });

  it("reads browser key events, including Option keys on a Mac", () => {
    expect(keyFromEvent(event("x", "KeyX"))).toBe("x");
    expect(keyFromEvent(event("X", "KeyX", { shift: true }))).toBe("X");
    expect(keyFromEvent(event("Enter", "Enter"))).toBe("ret");
    expect(keyFromEvent(event("Tab", "Tab", { shift: true }))).toBe("S-tab");
    expect(keyFromEvent(event("ArrowUp", "ArrowUp", { alt: true }))).toBe("A-up");
    expect(keyFromEvent(event("w", "KeyW", { ctrl: true }))).toBe("C-w");
    // Option-x types ≈, Option-; types …, and Option-u starts an accent.
    expect(keyFromEvent(event("≈", "KeyX", { alt: true }))).toBe("A-x");
    expect(keyFromEvent(event("…", "Semicolon", { alt: true }))).toBe("A-;");
    expect(keyFromEvent(event("Dead", "KeyU", { alt: true }))).toBe("A-u");
    expect(keyFromEvent(event("Ó", "KeyH", { alt: true, shift: true }))).toBe("A-H");
    expect(keyFromEvent(event("Shift", "ShiftLeft", { shift: true }))).toBeNull();
    expect(keyFromEvent(event("Dead", "BracketLeft"))).toBeNull();
  });
});

describe("keymaps from config", () => {
  it("merges keys in, and reports problems without dropping the rest", () => {
    const { keymaps, problems } = keymapsWithConfig({
      normal: {
        X: "extend_line_above",
        g: { x: "no_such_command" },
        "Q-x": "undo",
        space: { y: ":w" },
      },
      visual: {},
    });
    expect(keymaps.normal.map.get(parseKey("X"))).toMatchObject({ kind: "command" });
    expect(problems.map((p) => p.path)).toEqual([
      "keys.normal.g.x",
      "keys.normal.Q-x",
      "keys.visual",
    ]);
    // The rest of the goto keys are still there.
    const g = keymaps.normal.map.get(parseKey("g"));
    expect(g?.kind === "node" && g.node.map.has(parseKey("g"))).toBe(true);
  });

  it("shows help for keys that can come next", async () => {
    const h = harness("#[a|]#bc\n");
    await h.keys("g");
    expect(h.editor.autoinfo?.title).toBe("Goto");
    expect(h.editor.autoinfo?.body).toContainEqual(["g", "Goto line number `<n>` else file start"]);
    await h.keys("<esc>");
    expect(h.editor.autoinfo).toBeNull();
    const space = keymapsWithConfig(undefined).keymaps.normal.map.get(parseKey("space"));
    if (space?.kind !== "node") throw new Error("space should be a node");
    expect(infobox(space.node).body).toContainEqual(["y", "Yank selections to clipboard"]);
  });

  it("explains commands Workshop doesn't have rather than doing nothing", async () => {
    const h = harness("#[a|]#bc\n");
    await h.keys("<space>f");
    expect(h.editor.status?.message).toMatch(/file_picker isn't available in Workshop/);
    await h.keys(":buffer-close<ret>");
    expect(h.editor.status?.message).toMatch(/:buffer-close isn't available/);
  });
});
