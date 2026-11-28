import { describe, expect, it } from "vitest";
import { splitCodeBlocks } from "./codeBlocks";

describe("splitCodeBlocks", () => {
  it("finds each fenced code block between the prose", () => {
    const text =
      'Run:\n\n```sh\npython3 -m timeit "1 in xs"\necho done\n```\n\nRecord it.\n\n~~~\nplain\n~~~';
    expect(splitCodeBlocks(text)).toEqual([
      { kind: "text", text: "Run:\n" },
      {
        kind: "code",
        markdown: '```sh\npython3 -m timeit "1 in xs"\necho done\n```',
        code: 'python3 -m timeit "1 in xs"\necho done',
      },
      { kind: "text", text: "\nRecord it.\n" },
      { kind: "code", markdown: "~~~\nplain\n~~~", code: "plain" },
    ]);
  });

  it("closes a block only with the same fence, at least as long", () => {
    const text = "````md\n```sh\nls\n```\n~~~\n````\nAfter.";
    expect(splitCodeBlocks(text)).toEqual([
      { kind: "code", markdown: "````md\n```sh\nls\n```\n~~~\n````", code: "```sh\nls\n```\n~~~" },
      { kind: "text", text: "After." },
    ]);
  });

  it("runs a block left open to the end, and leaves prose alone", () => {
    expect(splitCodeBlocks("```\nls -l")).toEqual([
      { kind: "code", markdown: "```\nls -l", code: "ls -l" },
    ]);
    expect(splitCodeBlocks("Just `inline` code.")).toEqual([
      { kind: "text", text: "Just `inline` code." },
    ]);
  });
});
