import { describe, expect, it } from "vitest";
import { codeActions, editsFor, hoverMarkdown, locations } from "./lspActions";

const range = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

describe("locations", () => {
  it("reads one place, a list of them, or links to them", () => {
    const place = { uri: "file:///a.py", range: range(1, 0, 4) };
    expect(locations(place)).toEqual([place]);
    expect(locations([place, place])).toEqual([place, place]);
    expect(
      locations([
        {
          targetUri: "file:///b.py",
          targetRange: range(2, 0, 9),
          targetSelectionRange: range(2, 4, 9),
        },
      ]),
    ).toEqual([{ uri: "file:///b.py", range: range(2, 4, 9) }]);
  });

  it("reads no answer as nowhere", () => {
    expect(locations(null)).toEqual([]);
    expect(locations([])).toEqual([]);
  });

  it("refuses what isn't a place", () => {
    expect(() => locations([{ uri: "file:///a.py" }])).toThrow();
    expect(() => locations("file:///a.py")).toThrow();
  });
});

describe("editsFor", () => {
  const here = "file:///a.py";
  const edit = { range: range(0, 0, 3), newText: "new" };

  it("takes the open file's edits, counting the files left alone", () => {
    expect(editsFor({ changes: { [here]: [edit], "file:///b.py": [edit] } }, here)).toEqual({
      edits: [edit],
      elsewhere: 1,
    });
  });

  it("reads edits listed by document, which win over those listed by file", () => {
    const workspaceEdit = {
      changes: { [here]: [] },
      documentChanges: [
        { textDocument: { uri: here, version: 3 }, edits: [edit, edit] },
        { textDocument: { uri: "file:///b.py", version: 1 }, edits: [edit] },
        { kind: "create", uri: "file:///c.py" },
      ],
    };
    expect(editsFor(workspaceEdit, here)).toEqual({ edits: [edit, edit], elsewhere: 2 });
  });

  it("finds nothing in an edit of nothing, or of other files alone", () => {
    expect(editsFor({}, here)).toEqual({ edits: [], elsewhere: 0 });
    expect(editsFor({ changes: { "file:///b.py": [edit] } }, here)).toEqual({
      edits: [],
      elsewhere: 1,
    });
  });

  it("refuses an edit it can't read", () => {
    expect(() =>
      editsFor({ changes: { [here]: [{ range: range(0, 0, 1) } as never] } }, here),
    ).toThrow();
    expect(() =>
      editsFor({ documentChanges: [{ textDocument: { uri: here }, edits: "all" }] }, here),
    ).toThrow();
  });
});

describe("codeActions", () => {
  it("tells actions with edits from those to ask for, commands, and those that can't be used", () => {
    const edit = { changes: {} };
    const [withEdit, toResolve, bare, withCommand, disabled] = codeActions([
      { title: "Fix", edit },
      { title: "Fix later", data: 1 },
      { title: "Run", command: "server.run" },
      { title: "Fix and run", command: { title: "Run", command: "server.run" } },
      { title: "No", disabled: { reason: "Not here" } },
    ]);
    expect(withEdit).toMatchObject({ title: "Fix", edit, command: false, resolvable: false });
    expect(toResolve).toMatchObject({ edit: null, command: false, resolvable: true });
    expect(bare).toMatchObject({ edit: null, command: true, resolvable: false });
    expect(withCommand).toMatchObject({ edit: null, command: true, resolvable: false });
    expect(disabled).toMatchObject({ disabled: "Not here" });
  });

  it("asks for the edit of a command that came with data to ask by", () => {
    const [action] = codeActions([{ title: "Fix", command: { command: "x" }, data: {} }]);
    expect(action).toMatchObject({ command: true, resolvable: true });
  });

  it("reads no answer as none, and refuses what isn't a list of actions", () => {
    expect(codeActions(null)).toEqual([]);
    expect(() => codeActions({})).toThrow();
    expect(() => codeActions([{ edit: {} }])).toThrow();
  });
});

describe("hoverMarkdown", () => {
  it("reads markdown, plain text, code and lists of them", () => {
    expect(hoverMarkdown("plain")).toBe("plain");
    expect(hoverMarkdown({ kind: "markdown", value: "**bold**" })).toBe("**bold**");
    expect(hoverMarkdown({ language: "python", value: "x: int" })).toBe("```python\nx: int\n```");
    expect(hoverMarkdown(["one", { value: "two" }])).toBe("one\n\ntwo");
    expect(hoverMarkdown(null)).toBe("");
  });
});
