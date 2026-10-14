import { describe, expect, it } from "vitest";
import { resolveDictation } from "./dictation";

const all = { server: true, browser: true };

describe("resolveDictation", () => {
  it("uses Whisper on the server by default when it's ready", () => {
    expect(resolveDictation("auto", all)).toBe("server");
    expect(resolveDictation("server", all)).toBe("server");
  });

  it("falls back to the browser's recognition, then the keyboard", () => {
    expect(resolveDictation("auto", { server: false, browser: true })).toBe("browser");
    expect(resolveDictation("server", { server: false, browser: true })).toBe("browser");
    expect(resolveDictation("auto", { server: false, browser: false })).toBe("keyboard");
    expect(resolveDictation("browser", { server: false, browser: false })).toBe("keyboard");
  });

  it("uses what's chosen when it's available", () => {
    expect(resolveDictation("browser", all)).toBe("browser");
    expect(resolveDictation("keyboard", all)).toBe("keyboard");
    expect(resolveDictation("browser", { server: true, browser: false })).toBe("server");
  });
});
