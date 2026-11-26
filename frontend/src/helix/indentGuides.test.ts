import { describe, expect, it } from "vitest";
import { helixSettings } from "./config";
import { indentGuideColumns, indentGuideSpan, lineIndentColumn } from "./indentGuides";
import { harness } from "./testing";

describe("lineIndentColumn", () => {
  it("measures leading spaces", () => {
    expect(lineIndentColumn("def foo():", 4)).toBe(0);
    expect(lineIndentColumn("    pass", 4)).toBe(4);
    expect(lineIndentColumn("      x = 1", 4)).toBe(6);
  });

  it("expands tabs to the next tab stop", () => {
    expect(lineIndentColumn("\tfoo", 4)).toBe(4);
    expect(lineIndentColumn("\t\tfoo", 4)).toBe(8);
    expect(lineIndentColumn(" \tfoo", 4)).toBe(4);
    expect(lineIndentColumn("   \tfoo", 4)).toBe(4);
    expect(lineIndentColumn("    \tfoo", 4)).toBe(8);
    expect(lineIndentColumn("\t  foo", 4)).toBe(6);
    expect(lineIndentColumn("\t\tfoo", 2)).toBe(4);
  });

  it("returns null for empty and whitespace-only lines", () => {
    expect(lineIndentColumn("", 4)).toBeNull();
    expect(lineIndentColumn("   ", 4)).toBeNull();
    expect(lineIndentColumn("\t\t  ", 4)).toBeNull();
    expect(lineIndentColumn("\u00A0\u2003", 4)).toBeNull();
  });

  it("accounts for unicode inline whitespace widths", () => {
    expect(lineIndentColumn("\u00A0\u00A0x", 4)).toBe(2);
    expect(lineIndentColumn("\u3000\u3000x", 4)).toBe(4);
    expect(lineIndentColumn("\u200B    x", 4)).toBe(4);
  });

  it("rejects invalid tab widths", () => {
    expect(() => lineIndentColumn("    x", 0)).toThrow(RangeError);
    expect(() => lineIndentColumn("    x", -2)).toThrow(RangeError);
    expect(() => lineIndentColumn("    x", 2.5)).toThrow(RangeError);
  });
});

describe("indentGuideSpan", () => {
  it("uses floor division matching Helix's end_indent = indent_level / indent_width", () => {
    expect(indentGuideSpan(0, 4, 0)).toBeNull();
    expect(indentGuideSpan(3, 4, 0)).toBeNull();
    expect(indentGuideSpan(4, 4, 0)).toEqual({ startCol: 0, count: 1 });
    expect(indentGuideSpan(5, 4, 0)).toEqual({ startCol: 0, count: 1 });
    expect(indentGuideSpan(7, 4, 0)).toEqual({ startCol: 0, count: 1 });
    expect(indentGuideSpan(8, 4, 0)).toEqual({ startCol: 0, count: 2 });
  });

  it("applies skipLevels from column 0", () => {
    expect(indentGuideSpan(4, 4, 1)).toBeNull();
    expect(indentGuideSpan(8, 4, 1)).toEqual({ startCol: 4, count: 1 });
    expect(indentGuideSpan(12, 4, 1)).toEqual({ startCol: 4, count: 2 });
    expect(indentGuideSpan(12, 4, 2)).toEqual({ startCol: 8, count: 1 });
    expect(indentGuideSpan(12, 4, 3)).toBeNull();
  });

  it("rejects invalid inputs", () => {
    expect(() => indentGuideSpan(-1, 4, 0)).toThrow(RangeError);
    expect(() => indentGuideSpan(4, 0, 0)).toThrow(RangeError);
    expect(() => indentGuideSpan(4, 4, -1)).toThrow(RangeError);
    expect(() => indentGuideSpan(4, 4, 0.5)).toThrow(RangeError);
  });
});

describe("indentGuideColumns", () => {
  it("tracks nested and dedented blocks without drawing over text", () => {
    const lines = [
      "def f():",
      "    if a:",
      "        if b:",
      "            return 1",
      "        return 2",
      "    return 3",
      "x = 0",
    ];
    expect(indentGuideColumns(lines, { indentWidth: 4, tabWidth: 4 })).toEqual([
      [],
      [0],
      [0, 4],
      [0, 4, 8],
      [0, 4],
      [0],
      [],
    ]);
  });

  it("reuses the previous non-blank line's indent level on blank and whitespace-only lines", () => {
    const lines = [
      "",
      "    ",
      "        deep()",
      "",
      "  ",
      "                ",
      "    outer()",
      "",
      "top()",
      "",
    ];
    expect(indentGuideColumns(lines, { indentWidth: 4, tabWidth: 4 })).toEqual([
      [],
      [],
      [0, 4],
      [0, 4],
      [0, 4],
      [0, 4],
      [0],
      [0],
      [],
      [],
    ]);
  });

  it("handles tabs, mixed whitespace, and indentWidth differing from tabWidth", () => {
    const goLines = ["func f() {", "\tif a {", "\t\treturn", "\t}", "}"];
    expect(indentGuideColumns(goLines, { indentWidth: 4, tabWidth: 4 })).toEqual([
      [],
      [0],
      [0, 4],
      [0],
      [],
    ]);

    const mixed = ["  \taligned", "\t  extra", "\ttwoSpaces"];
    expect(indentGuideColumns(mixed, { indentWidth: 4, tabWidth: 4 })).toEqual([[0], [0], [0]]);
    // A 4-column tab in a 2-space file spans two indent levels.
    expect(indentGuideColumns(["\tfoo"], { indentWidth: 2, tabWidth: 4 })).toEqual([[0, 2]]);
    // A 2-column tab width (e.g. TypeScript/Haskell).
    expect(indentGuideColumns(["\t\tfoo"], { indentWidth: 2, tabWidth: 2 })).toEqual([[0, 2]]);
  });

  it("skips leading levels when skipLevels is set", () => {
    const lines = ["a", "  b", "    c", "", "      d", "  e"];
    expect(indentGuideColumns(lines, { indentWidth: 2, tabWidth: 2, skipLevels: 1 })).toEqual([
      [],
      [],
      [2],
      [2],
      [2, 4],
      [],
    ]);
  });

  it("carries initialIndent into leading blank lines of a visible slice", () => {
    expect(
      indentGuideColumns(["", "  ", "    next()"], {
        indentWidth: 4,
        tabWidth: 4,
        initialIndent: 8,
      }),
    ).toEqual([[0, 4], [0, 4], [0]]);
  });

  it("never places a guide at or past the first non-whitespace column", () => {
    const lines = ["x", " x", "  x", "   x", "    x", "     x", "      x", "       x", "        x"];
    const guides = indentGuideColumns(lines, { indentWidth: 4, tabWidth: 4 });
    for (const [i, line] of lines.entries()) {
      const firstText = lineIndentColumn(line, 4);
      if (firstText === null) continue;
      for (const col of guides[i] ?? []) {
        expect(col).toBeLessThan(firstText);
      }
    }
  });
});

describe("indent-guides config and typed options", () => {
  it("leaves indent guides off by default, as Helix does, and respects config overrides", () => {
    expect(helixSettings({}).options.indentGuides).toEqual({ render: false, skipLevels: 0 });
    expect(
      helixSettings({ "indent-guides": { render: true, "skip-levels": 2 } }).options.indentGuides,
    ).toEqual({ render: true, skipLevels: 2 });
  });

  it("supports :get, :set and :toggle for indent-guides options", async () => {
    const h = harness("#[a|]#\n");
    expect(h.editor.options.indentGuides).toEqual({ render: false, skipLevels: 0 });

    await h.keys(":toggle indent-guides.render<ret>");
    expect(h.editor.options.indentGuides.render).toBe(true);

    await h.keys(":set indent-guides.render false<ret>");
    expect(h.editor.options.indentGuides.render).toBe(false);

    await h.keys(":set indent-guides.skip-levels 2<ret>");
    expect(h.editor.options.indentGuides.skipLevels).toBe(2);

    await h.keys(":get indent-guides.skip-levels<ret>");
    expect(h.editor.status?.message).toBe("2");
  });
});
