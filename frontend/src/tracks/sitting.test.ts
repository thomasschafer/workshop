import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aWhile, IDLE_MS, isOn, parse, setAWhile, TOUCH_MS, touch } from "./sitting";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const START = 1_790_000_000_000;

describe("I've got a while", () => {
  it("is off until it's turned on", () => {
    expect(aWhile(START)).toBe(false);
    setAWhile(true, START);
    expect(aWhile(START + 1000)).toBe(true);
    setAWhile(false, START + 2000);
    expect(aWhile(START + 3000)).toBe(false);
  });

  it("turns itself off once the learner has been away a while", () => {
    setAWhile(true, START);
    expect(aWhile(START + IDLE_MS - 1)).toBe(true);
    expect(aWhile(START + IDLE_MS)).toBe(false);
  });

  it("stays on while the learner keeps doing things, however long the sitting", () => {
    setAWhile(true, START);
    let now = START;
    for (let i = 0; i < 10; i++) {
      now += IDLE_MS - 1000;
      touch(now);
    }
    expect(now - START).toBeGreaterThan(4 * IDLE_MS);
    expect(aWhile(now + IDLE_MS - 1000)).toBe(true);
  });

  it("notes activity at most once a minute", () => {
    setAWhile(true, START);
    touch(START + TOUCH_MS - 1);
    expect(parse(localStorage.getItem("workshop:a-while"))).toEqual({ lastActive: START });
    touch(START + TOUCH_MS);
    expect(parse(localStorage.getItem("workshop:a-while"))).toEqual({
      lastActive: START + TOUCH_MS,
    });
  });

  it("stays off once the sitting's over, even if the learner comes back", () => {
    setAWhile(true, START);
    touch(START + IDLE_MS + 1);
    expect(localStorage.getItem("workshop:a-while")).toBeNull();
    expect(aWhile(START + IDLE_MS + 2)).toBe(false);
    // Touching while it's off doesn't turn it on.
    touch(START + IDLE_MS + 3);
    expect(aWhile(START + IDLE_MS + 4)).toBe(false);
  });

  it("is off when what's kept can't be read, or is from a clock that's since gone back", () => {
    expect(parse("not json")).toBeNull();
    expect(parse('{"lastActive":"soon"}')).toBeNull();
    expect(parse("null")).toBeNull();
    expect(isOn({ lastActive: START }, START - 60_000)).toBe(false);
  });
});
