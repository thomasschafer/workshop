import { describe, expect, it } from "vitest";
import { resolveDictation } from "./dictation";

describe("resolveDictation", () => {
  it("uses the browser's recognition by default where there is one", () => {
    expect(resolveDictation("auto", true)).toBe("browser");
    expect(resolveDictation("browser", true)).toBe("browser");
  });

  it("falls back to the keyboard where there isn't", () => {
    expect(resolveDictation("auto", false)).toBe("keyboard");
    expect(resolveDictation("browser", false)).toBe("keyboard");
  });

  it("uses the keyboard when chosen", () => {
    expect(resolveDictation("keyboard", true)).toBe("keyboard");
  });
});
