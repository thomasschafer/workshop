import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { CodeSaver, LatestSaver } from "./saver";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LatestSaver", () => {
  it("saves only the latest value once changes pause", async () => {
    const save = vi.fn().mockResolvedValue(null);
    const saver = new LatestSaver<string>(save, 500, () => {});
    saver.schedule("a");
    saver.schedule("ab");
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledExactlyOnceWith("ab");
  });

  it("retries until the save succeeds", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(null);
    const errors: string[] = [];
    const saver = new LatestSaver<string>(save, 100, (e) => errors.push(e));
    saver.schedule("notes");
    await vi.advanceTimersByTimeAsync(100 + 1000 + 2000);
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenLastCalledWith("notes");
    expect(errors).toEqual(["offline", "offline"]);
  });

  it("retries with a newer value if one arrived meanwhile", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(null);
    const saver = new LatestSaver<string>(save, 100, () => {});
    saver.schedule("old");
    await vi.advanceTimersByTimeAsync(100);
    saver.schedule("new");
    await vi.advanceTimersByTimeAsync(2000);
    expect(save.mock.calls).toEqual([["old"], ["new"]]);
  });
});

describe("CodeSaver", () => {
  const puzzle = { year: 2017, day: 4 };

  it("retries failed saves without waiting for another edit", async () => {
    const saveCode = vi
      .spyOn(api, "saveCode")
      .mockRejectedValueOnce(new Error("server restarting"))
      .mockResolvedValue({ text: "x", version: "v2", path: "/p" });
    const statuses: string[] = [];
    const saver = new CodeSaver(
      puzzle,
      "v1",
      (s) => statuses.push(s),
      () => {},
    );
    saver.schedule("x");
    await vi.advanceTimersByTimeAsync(400);
    expect(statuses).toContain("error");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveCode).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("treats a conflict with its own text as saved", async () => {
    vi.spyOn(api, "saveCode").mockRejectedValue(
      new ApiError("conflict", 409, { current: { text: "x", version: "v9", path: "/p" } }),
    );
    const onConflict = vi.fn();
    const statuses: string[] = [];
    const saver = new CodeSaver(puzzle, "v1", (s) => statuses.push(s), onConflict);
    saver.schedule("x");
    await vi.advanceTimersByTimeAsync(400);
    expect(onConflict).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe("saved");
  });

  it("stops on a real conflict", async () => {
    const current = { text: "changed at a desk", version: "v9", path: "/p" };
    vi.spyOn(api, "saveCode").mockRejectedValue(new ApiError("conflict", 409, { current }));
    const onConflict = vi.fn();
    const statuses: string[] = [];
    const saver = new CodeSaver(puzzle, "v1", (s) => statuses.push(s), onConflict);
    saver.schedule("x");
    await vi.advanceTimersByTimeAsync(400);
    expect(onConflict).toHaveBeenCalledWith(current);
    expect(statuses.at(-1)).toBe("conflict");
  });
});
