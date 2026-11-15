import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors";

describe("errorMessage", () => {
  it("gives the message of an error, or of a language server's error", () => {
    expect(errorMessage(new Error("it broke"))).toBe("it broke");
    expect(errorMessage({ code: -32603, message: "couldn't parse it" })).toBe("couldn't parse it");
  });

  it("gives anything else as text", () => {
    expect(errorMessage("it broke")).toBe("it broke");
    expect(errorMessage({ code: 1 })).toBe("[object Object]");
  });
});
