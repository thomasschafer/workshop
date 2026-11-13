import { describe, expect, it } from "vitest";
import { type Fingers, swipeDirection } from "./swipe";

const fingers = (ax: number, ay: number, bx: number, by: number): Fingers => [
  { x: ax, y: ay },
  { x: bx, y: by },
];

describe("a two-finger sweep", () => {
  const start = fingers(200, 300, 260, 320);

  it("goes the way both fingers went", () => {
    expect(swipeDirection(start, fingers(90, 310, 150, 330))).toBe("left");
    expect(swipeDirection(start, fingers(320, 290, 380, 310))).toBe("right");
  });

  it("needs both fingers to travel far enough", () => {
    expect(swipeDirection(start, fingers(150, 300, 210, 320))).toBeNull();
    expect(swipeDirection(start, fingers(90, 300, 240, 320))).toBeNull();
  });

  it("isn't a scroll up or down, or a slant that's as much one as the other", () => {
    expect(swipeDirection(start, fingers(200, 100, 260, 120))).toBeNull();
    expect(swipeDirection(start, fingers(100, 200, 160, 220))).toBeNull();
  });

  it("isn't a pinch, whose fingers part or close", () => {
    expect(swipeDirection(start, fingers(120, 300, 380, 320))).toBeNull();
    expect(swipeDirection(fingers(100, 300, 300, 300), fingers(180, 300, 380, 300))).toBe("right");
    expect(swipeDirection(fingers(100, 300, 300, 300), fingers(180, 300, 460, 300))).toBeNull();
  });

  it("isn't fingers going opposite ways", () => {
    expect(swipeDirection(start, fingers(100, 300, 360, 320))).toBeNull();
  });
});
