// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are snippets, not templates
import { describe, expect, it } from "vitest";
import { lspToSnippet, shownLabel } from "./lspCompletion";

describe("lspToSnippet", () => {
  it("puts braces around bare field numbers and drops escapes", () => {
    expect(lspToSnippet("takeWhile ${1:p} $2")).toBe("takeWhile ${1:p} ${2}");
    expect(lspToSnippet("cost \\$5 {\\}}$0")).toBe("cost $5 {}}${0}");
  });
});

describe("shownLabel", () => {
  it("shows the completion's detail without label details", () => {
    expect(shownLabel({ label: "fetch", detail: "Auto-import" })).toEqual({
      label: "fetch",
      detail: "Auto-import",
    });
    expect(shownLabel({ label: "fetch" })).toEqual({ label: "fetch" });
  });

  it("puts the label details' detail after the label, and their description in place of detail", () => {
    expect(
      shownLabel({
        label: "fetch",
        labelDetails: { detail: "(url)", description: "requests" },
        detail: "def fetch(url: str) -> bytes",
      }),
    ).toEqual({ label: "fetch(url)", detail: "requests" });
  });

  it("keeps the completion's detail where the label details have no description", () => {
    expect(
      shownLabel({ label: "fetch", labelDetails: { detail: "(url)" }, detail: "Auto-import" }),
    ).toEqual({ label: "fetch(url)", detail: "Auto-import" });
  });
});
