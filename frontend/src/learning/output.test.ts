import { describe, expect, it } from "vitest";
import cases from "../../../crates/pack/tests/output.json";
import { normaliseOutput, sameOutput } from "./output";

describe("sameOutput", () => {
  it("compares as the server does", () => {
    expect(cases.length).toBeGreaterThan(5);
    for (const { expected, actual, same } of cases) {
      expect(sameOutput(expected, actual), `${JSON.stringify(actual)} against ${expected}`).toBe(
        same,
      );
    }
  });

  it("keeps what's inside the lines", () => {
    expect(normaliseOutput("\n  a  b \n\n c\n\n")).toBe("  a  b\n\n c");
  });
});
