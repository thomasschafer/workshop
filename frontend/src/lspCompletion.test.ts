// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are snippets, not templates
import { describe, expect, it } from "vitest";
import { lspToSnippet } from "./lspCompletion";

describe("lspToSnippet", () => {
  it("puts braces around bare field numbers and drops escapes", () => {
    expect(lspToSnippet("takeWhile ${1:p} $2")).toBe("takeWhile ${1:p} ${2}");
    expect(lspToSnippet("cost \\$5 {\\}}$0")).toBe("cost $5 {}}${0}");
  });
});
