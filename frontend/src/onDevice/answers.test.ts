import { describe, expect, it } from "vitest";
import cases from "../../../crates/runner/tests/answers.json";
import { answerWarnings, parseAnswers } from "./answers";

describe("AoC answer parsing", () => {
  it("matches the shared Rust runner fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const c of cases) {
      const answers = parseAnswers(c.stdout);
      const warnings = answerWarnings(answers);
      expect(answers, `stdout=${JSON.stringify(c.stdout)}`).toEqual(c.answers);
      expect(warnings, `stdout=${JSON.stringify(c.stdout)}`).toEqual(c.warnings);
    }
  });
});
