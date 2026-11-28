import { describe, expect, it } from "vitest";
import { labEditsInTurn } from "./labEdits";

describe("labEditsInTurn", () => {
  it("sends each screen moved through since the server's furthest, with what was recorded to it", () => {
    const edit = { at: 3, records: ["one", "two", "three"], explanation: "" };
    expect(labEditsInTurn(edit, 0, 3)).toEqual([
      { at: 1, records: ["one", "", ""], explanation: "" },
      { at: 2, records: ["one", "two", ""], explanation: "" },
      edit,
    ]);
  });

  it("goes as far as the learner has been before going back", () => {
    // Answered at the end, then back to the first step, before any of it was saved.
    const back = { at: 1, records: ["one", "two"], explanation: "Because." };
    expect(labEditsInTurn(back, 0, 3)).toEqual([
      { at: 1, records: ["one", ""], explanation: "" },
      { at: 2, records: ["one", "two"], explanation: "" },
      { at: 3, records: ["one", "two"], explanation: "Because." },
      back,
    ]);
  });

  it("sends just the edit at or behind where the server's reached", () => {
    const back = { at: 1, records: ["one", "two"], explanation: "Because." };
    expect(labEditsInTurn(back, 3, 3)).toEqual([back]);
    const next = { at: 2, records: ["one", "two"], explanation: "" };
    expect(labEditsInTurn(next, 1, 2)).toEqual([next]);
  });
});
