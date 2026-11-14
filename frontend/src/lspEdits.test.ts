import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { offsetIn, placeEdits } from "./lspEdits";

const doc = Text.of(["import Data.Char (ord)", "", "main = print (sortOn)"]);
const at = (line: number, character: number) => ({ line, character });
const insertion = (line: number, character: number, newText: string) => ({
  range: { start: at(line, character), end: at(line, character) },
  newText,
});

describe("offsetIn", () => {
  it("finds a position, taking one past the end of its line to mean the line's end", () => {
    expect(offsetIn(doc, at(0, 0))).toBe(0);
    expect(offsetIn(doc, at(2, 7))).toBe(doc.line(3).from + 7);
    expect(offsetIn(doc, at(1, 40))).toBe(doc.line(2).from);
  });

  it("takes the start of the line after the last to be the end of the file", () => {
    expect(offsetIn(doc, at(3, 0))).toBe(doc.length);
  });

  it("refuses a position past the end of the file", () => {
    expect(() => offsetIn(doc, at(3, 1))).toThrow();
    expect(() => offsetIn(doc, at(7, 0))).toThrow();
  });
});

describe("placeEdits", () => {
  it("places edits as they were made when nothing's changed since", () => {
    const placed = placeEdits(doc, ChangeSet.empty(doc.length), [
      insertion(1, 0, "import Data.List (sortOn)\n"),
    ]);
    expect(placed).toEqual([
      { from: doc.line(2).from, to: doc.line(2).from, insert: "import Data.List (sortOn)\n" },
    ]);
  });

  it("moves them past what's been typed before them since", () => {
    const typed = ChangeSet.of({ from: 0, insert: "-- notes\n" }, doc.length);
    const [placed] = placeEdits(doc, typed, [insertion(1, 0, "import Data.List (sortOn)\n")]) ?? [];
    expect(placed).toEqual({
      from: doc.line(2).from + 9,
      to: doc.line(2).from + 9,
      insert: "import Data.List (sortOn)\n",
    });
  });

  it("leaves them where they were for what's been typed after them", () => {
    const typed = ChangeSet.of({ from: doc.length, insert: " xs" }, doc.length);
    const edit = {
      range: { start: at(0, 0), end: at(0, 22) },
      newText: "import Data.Char (isDigit, ord)",
    };
    expect(placeEdits(doc, typed, [edit])).toEqual([
      { from: 0, to: 22, insert: "import Data.Char (isDigit, ord)" },
    ]);
  });

  it("places none if what they change has changed since", () => {
    const typed = ChangeSet.of({ from: 10, to: 14, insert: "Text" }, doc.length);
    const edit = {
      range: { start: at(0, 0), end: at(0, 22) },
      newText: "import Data.Char (isDigit, ord)",
    };
    expect(placeEdits(doc, typed, [insertion(1, 0, "\n"), edit])).toBeNull();
  });
});
