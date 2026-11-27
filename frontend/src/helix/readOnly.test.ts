import { describe, expect, it } from "vitest";
import { harness } from "./testing";

describe("read-only buffers in Helix mode", () => {
  it("refuses deleting, inserting, appending and changing, showing a read-only error", async () => {
    const original = "hello\nworld\n";
    for (const seq of ["d", "i", "a", "o", "c", "xd"]) {
      const h = harness("#[h|]#ello\nworld\n", { readOnly: true });
      await h.keys(seq);
      expect(h.host.state.doc.toString()).toBe(original);
      expect(h.mode()).toBe("normal");
      expect(h.editor.status).toEqual({ message: "This file is read-only", severity: "error" });
    }
  });

  it("still allows moving, selecting lines with x, and yanking on a read-only buffer", async () => {
    const h = harness("#[h|]#ello\nworld\n", { readOnly: true });
    await h.keys("xy");
    expect(h.host.state.doc.toString()).toBe("hello\nworld\n");
    expect(h.state()).toBe("#[hello\n|]#world\n");
    expect(await h.editor.registers.read('"')).toEqual(["hello\n"]);
  });
});
