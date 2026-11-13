import { describe, expect, it } from "vitest";
import {
  type KeyBox,
  LEARNING_RATE,
  learn,
  MAX_OFFSET,
  measure,
  NO_OFFSETS,
  nearestKey,
  parseOffsets,
  TouchLearner,
} from "./touchModel";

/** Three keys in a row and one beneath, 30 wide and 40 tall, with gaps of 10: a column is 40. */
const COLUMN = 40;
const key = (id: string, column: number, row: number): KeyBox => ({
  id,
  left: column * COLUMN,
  top: row * 50,
  right: column * COLUMN + 30,
  bottom: row * 50 + 40,
});
const BOXES = [
  key("a", 0, 0),
  key("s", 1, 0),
  key("d", 2, 0),
  key("x", 1, 1),
  key("Backspace", 3, 1),
];
const box = (id: string): KeyBox => {
  const found = BOXES.find((b) => b.id === id);
  if (!found) throw new Error(`no key ${id}`);
  return found;
};
const pressed = (x: number, y: number, offsets = NO_OFFSETS) =>
  nearestKey(BOXES, { x, y }, offsets, COLUMN)?.id;

describe("the nearest key", () => {
  it("is the key a touch is on", () => {
    expect(pressed(15, 20)).toBe("a");
    expect(pressed(55, 20)).toBe("s");
  });

  it("is the closer key for a touch in the gap between two", () => {
    expect(pressed(33, 20)).toBe("a");
    expect(pressed(37, 20)).toBe("s");
    expect(pressed(55, 43)).toBe("s");
    expect(pressed(55, 47)).toBe("x");
  });

  it("is the key at the edge for a touch beyond it", () => {
    expect(pressed(-20, 20)).toBe("a");
    expect(pressed(15, -30)).toBe("a");
    expect(pressed(10, 70)).toBe("x");
  });

  it("follows a key to where it's touched", () => {
    // `s` is touched a quarter of a column to the left, so the gap beside `a` is now its own.
    const offsets = { s: { x: -0.25, y: 0 } };
    expect(pressed(33, 20, offsets)).toBe("s");
    expect(pressed(15, 20, offsets)).toBe("a");
  });

  it("is null without keys", () => {
    expect(nearestKey([], { x: 0, y: 0 }, NO_OFFSETS, COLUMN)).toBeNull();
  });
});

describe("learning", () => {
  it("moves a key a little towards a touch", () => {
    const offsets = learn(NO_OFFSETS, { id: "a", offset: { x: 0.25, y: -0.1 } });
    expect(offsets.a?.x).toBeCloseTo(0.25 * LEARNING_RATE);
    expect(offsets.a?.y).toBeCloseTo(-0.1 * LEARNING_RATE);
  });

  it("never moves a key further than the limit", () => {
    let offsets = NO_OFFSETS;
    for (let i = 0; i < 500; i++) offsets = learn(offsets, { id: "a", offset: { x: 2, y: -2 } });
    expect(offsets.a).toEqual({ x: MAX_OFFSET, y: -MAX_OFFSET });
  });

  const learner = () => new TouchLearner(NO_OFFSETS, (id) => id === "Backspace");
  const touch = (l: TouchLearner, id: string, dx = 0, dy = 0) => {
    const b = box(id);
    return l.touched(b, { x: (b.left + b.right) / 2 + dx, y: (b.top + b.bottom) / 2 + dy }, COLUMN);
  };

  it("learns from a touch once the next key hasn't deleted it", () => {
    const l = learner();
    expect(touch(l, "a", 8)).toBeNull();
    const offsets = touch(l, "s");
    expect(offsets?.a?.x).toBeCloseTo((8 / COLUMN) * LEARNING_RATE);
    expect(offsets?.s).toBeUndefined();
  });

  it("learns nothing from a touch that's deleted", () => {
    const l = learner();
    touch(l, "a", 8);
    expect(touch(l, "Backspace")).toBeNull();
    // Far from `a`, so not what it was meant to be.
    expect(touch(l, "d")).toBeNull();
    expect(l.current).toEqual(NO_OFFSETS);
  });

  it("takes a deleted touch to have meant the key beside it that's pressed next", () => {
    const l = learner();
    // On the right of `a`, deleted, and then `s` is pressed: the touch was a miss of `s`.
    touch(l, "a", 14);
    touch(l, "Backspace");
    const offsets = touch(l, "s");
    const a = box("a");
    const s = box("s");
    const missedBy = ((a.left + a.right) / 2 + 14 - (s.left + s.right) / 2) / COLUMN;
    expect(offsets?.s?.x).toBeCloseTo(missedBy * LEARNING_RATE);
    expect(offsets?.a).toBeUndefined();
  });

  it("starts again from offsets it's given", () => {
    const l = learner();
    touch(l, "a", 8);
    l.reset({ d: { x: 0.1, y: 0 } });
    expect(touch(l, "s")).toBeNull();
    expect(l.current).toEqual({ d: { x: 0.1, y: 0 } });
  });
});

describe("measuring", () => {
  const at = (id: string, dx: number, dy: number) => {
    const b = box(id);
    return { id, point: { x: (b.left + b.right) / 2 + dx, y: (b.top + b.bottom) / 2 + dy } };
  };

  it("finds each key's offset, and the average for keys touched too little", () => {
    const touches = [at("a", 8, 4), at("a", 8, 4), at("a", 8, 4), at("s", 4, 0)];
    const m = measure(touches, BOXES, COLUMN);
    expect(m.touches).toBe(4);
    expect(m.offsets.a?.x).toBeCloseTo(0.2);
    expect(m.offsets.a?.y).toBeCloseTo(0.1);
    expect(m.average.x).toBeCloseTo(7 / COLUMN);
    // `s` was touched once, and `d` never: both take the average.
    expect(m.offsets.s).toEqual(m.offsets.d);
    expect(m.offsets.s?.x).toBeCloseTo(7 / COLUMN);
  });

  it("counts the touches each way of pressing keys gets wrong", () => {
    // Always 22 to the right of `a`: off the key as drawn, and nearer to `s`.
    const touches = [at("a", 22, 0), at("a", 22, 0), at("a", 22, 0), at("d", 0, 0)];
    const m = measure(touches, [box("a"), box("s"), box("d")], COLUMN);
    expect(m.offDrawnKey).toBe(3);
    expect(m.nearestWrong).toBe(3);
    expect(m.nearestWrongWithOffsets).toBe(0);
  });

  it("measures nothing from no touches", () => {
    expect(measure([], BOXES, COLUMN).offsets).toEqual({});
  });

  it("refuses a touch for a key that isn't there", () => {
    expect(() => measure([{ id: "q", point: { x: 0, y: 0 } }], BOXES, COLUMN)).toThrow();
  });
});

describe("stored offsets", () => {
  it("are read back, kept within the limit", () => {
    expect(parseOffsets('{"a":{"x":0.1,"y":-5}}')).toEqual({ a: { x: 0.1, y: -MAX_OFFSET } });
  });

  it("are refused if they aren't offsets", () => {
    for (const bad of ["", "[]", "3", '{"a":{"x":"1","y":0}}', '{"a":null}']) {
      expect(parseOffsets(bad)).toBeNull();
    }
  });
});
