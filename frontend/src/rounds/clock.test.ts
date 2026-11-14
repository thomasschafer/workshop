import { describe, expect, it } from "vitest";
import { BEAT_MS, clockText, MAX_GAP_MS, remainingAfter } from "./clock";

describe("remainingAfter", () => {
  const clock = { used_ms: 60_000, remaining_ms: 540_000 };

  it("counts down from what the server last said", () => {
    expect(remainingAfter(clock, 0)).toBe(540_000);
    expect(remainingAfter(clock, 4_500)).toBe(535_500);
  });

  it("stops after a short gap, as the server does without word from the app", () => {
    expect(remainingAfter(clock, 10 * 60_000)).toBe(540_000 - MAX_GAP_MS);
    expect(BEAT_MS * 2).toBeLessThan(MAX_GAP_MS);
  });

  it("never goes below nothing, or back up", () => {
    expect(remainingAfter({ used_ms: 595_000, remaining_ms: 5_000 }, 15_000)).toBe(0);
    expect(remainingAfter(clock, -1_000)).toBe(540_000);
  });
});

describe("clockText", () => {
  it("shows minutes and seconds, rounded up", () => {
    expect(clockText(600_000)).toBe("10:00");
    expect(clockText(59_001)).toBe("1:00");
    expect(clockText(59_000)).toBe("0:59");
    expect(clockText(1)).toBe("0:01");
    expect(clockText(0)).toBe("0:00");
    expect(clockText(-5)).toBe("0:00");
  });
});
