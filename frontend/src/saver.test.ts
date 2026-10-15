import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { type FileVersion, LatestSaver, type SaveStatus, VersionedSaver } from "./saver";

beforeEach(() => {
  vi.useFakeTimers();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Behaves like the server's versioned save, with ways to make requests fail. */
class FakeServer {
  text: string;
  version: number;
  /** Fail this many requests before they reach the server. */
  failBefore = 0;
  /** Apply this many requests, then fail before the response arrives. */
  failAfter = 0;
  saves: { text: string; keepalive: boolean }[] = [];

  constructor(text: string) {
    this.text = text;
    this.version = 1;
  }

  get file(): FileVersion {
    return { text: this.text, version: String(this.version) };
  }

  /** A change made elsewhere, such as at a desk. */
  editElsewhere(text: string): void {
    this.text = text;
    this.version++;
  }

  save = async (text: string, version: string, keepalive: boolean): Promise<FileVersion> => {
    this.saves.push({ text, keepalive });
    if (this.failBefore > 0) {
      this.failBefore--;
      throw new Error("offline");
    }
    if (version !== String(this.version)) {
      throw new ApiError("conflict", 409, { current: this.file });
    }
    if (text !== this.text) {
      this.text = text;
      this.version++;
    }
    if (this.failAfter > 0) {
      this.failAfter--;
      throw new Error("connection lost");
    }
    return this.file;
  };
}

function saverFor(server: FakeServer, key = "test") {
  const statuses: SaveStatus[] = [];
  const conflicts: FileVersion[] = [];
  const saver = new VersionedSaver(
    server.save,
    key,
    String(server.version),
    server.text,
    (s) => statuses.push(s),
    (theirs) => conflicts.push(theirs),
  );
  return { saver, statuses, conflicts };
}

describe("VersionedSaver", () => {
  it("saves shortly after a change and forgets the local copy once saved", async () => {
    const server = new FakeServer("a");
    const { saver, statuses } = saverFor(server);
    saver.schedule("ab");
    expect(localStorage.getItem("test")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(400);
    expect(server.text).toBe("ab");
    expect(statuses.at(-1)).toBe("saved");
    expect(localStorage.getItem("test")).toBeNull();
  });

  it("retries until the server is back, without waiting for another edit", async () => {
    const server = new FakeServer("a");
    server.failBefore = 2;
    const { saver, statuses } = saverFor(server);
    saver.schedule("ab");
    await vi.advanceTimersByTimeAsync(400 + 1000 + 2000);
    expect(server.text).toBe("ab");
    expect(statuses).toContain("error");
    expect(statuses.at(-1)).toBe("saved");
  });

  it("recognises its own save whose response was lost", async () => {
    const server = new FakeServer("a");
    server.failAfter = 1;
    const { saver, conflicts, statuses } = saverFor(server);
    saver.schedule("ab");
    await vi.advanceTimersByTimeAsync(400);
    saver.schedule("abc");
    await vi.advanceTimersByTimeAsync(2000);
    expect(conflicts).toEqual([]);
    expect(server.text).toBe("abc");
    expect(statuses.at(-1)).toBe("saved");
  });

  it("doesn't report a false conflict after a save sent as the page was hidden", async () => {
    const server = new FakeServer("a");
    const { saver, conflicts } = saverFor(server);
    saver.schedule("ab");
    // The page is hidden before the debounce fires; the response is never seen.
    server.failAfter = 1;
    saver.flushOnExit();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.saves.at(-1)).toEqual({ text: "ab", keepalive: true });
    saver.schedule("abc");
    await vi.advanceTimersByTimeAsync(2000);
    expect(conflicts).toEqual([]);
    expect(server.text).toBe("abc");
  });

  it("doesn't lose a save sent as the page was hidden while another was in flight", async () => {
    const server = new FakeServer("a");
    const { saver, conflicts } = saverFor(server);
    saver.schedule("ab");
    const inFlight = saver.flush().catch(() => {});
    saver.schedule("abc");
    saver.flushOnExit();
    await inFlight;
    await vi.advanceTimersByTimeAsync(2000);
    expect(conflicts).toEqual([]);
    expect(server.text).toBe("abc");
    // On waking, an unchanged version from the server is not taken over the local text.
    expect(saver.adopt(server.file)).toBe(false);
  });

  it("stops on a real conflict and keeps the local text until the user chooses", async () => {
    const server = new FakeServer("a");
    const { saver, conflicts, statuses } = saverFor(server);
    server.editElsewhere("desk");
    saver.schedule("phone");
    await vi.advanceTimersByTimeAsync(400);
    expect(conflicts).toEqual([{ text: "desk", version: "2" }]);
    expect(statuses.at(-1)).toBe("conflict");
    saver.schedule("phone, more");
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.text).toBe("desk");
    expect(JSON.parse(localStorage.getItem("test") ?? "{}").text).toBe("phone, more");
    await expect(saver.flush()).rejects.toThrow("changed elsewhere");

    saver.keepMine(conflicts[0] as FileVersion);
    await vi.advanceTimersByTimeAsync(400);
    expect(server.text).toBe("phone, more");
    expect(statuses.at(-1)).toBe("saved");
  });

  it("takes the other version when asked", async () => {
    const server = new FakeServer("a");
    const { saver, conflicts } = saverFor(server);
    server.editElsewhere("desk");
    saver.schedule("phone");
    await vi.advanceTimersByTimeAsync(400);
    saver.takeTheirs(conflicts[0] as FileVersion);
    expect(saver.hasUnsavedChanges).toBe(false);
    expect(localStorage.getItem("test")).toBeNull();
    saver.schedule("desk, then phone");
    await vi.advanceTimersByTimeAsync(400);
    expect(server.text).toBe("desk, then phone");
  });

  it("adopts changes made elsewhere only when there are no local changes", async () => {
    const server = new FakeServer("a");
    const { saver } = saverFor(server);
    server.editElsewhere("desk");
    expect(saver.adopt(server.file)).toBe(true);
    saver.schedule("desk, then phone");
    await vi.advanceTimersByTimeAsync(400);
    expect(server.text).toBe("desk, then phone");
  });

  it("doesn't save back a version from elsewhere as it's shown, racing the next change there", async () => {
    const server = new FakeServer("a");
    const { saver, conflicts } = saverFor(server);
    server.editElsewhere("desk");
    expect(saver.adopt(server.file)).toBe(true);
    // The editor reports showing it as a change.
    saver.schedule("desk");
    server.editElsewhere("desk, again");
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.saves).toEqual([]);
    expect(conflicts).toEqual([]);
    expect(saver.adopt(server.file)).toBe(true);
  });

  it("recovers unsaved text after a reload and saves it", async () => {
    const server = new FakeServer("a");
    server.failBefore = 100;
    const before = saverFor(server).saver;
    before.schedule("unsaved");
    // The page reloads; the server never got the text.
    server.failBefore = 0;
    const { saver } = saverFor(server);
    expect(saver.recover()).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(400);
    expect(server.text).toBe("unsaved");
  });

  it("reports a conflict when recovered text was based on an older version", async () => {
    const server = new FakeServer("a");
    server.failBefore = 100;
    saverFor(server).saver.schedule("unsaved");
    server.failBefore = 0;
    server.editElsewhere("desk");
    const { saver, conflicts } = saverFor(server);
    expect(saver.recover()).toBe("unsaved");
    expect(conflicts).toEqual([{ text: "desk", version: "2" }]);
    expect(server.text).toBe("desk");
  });

  it("rejects a flush that couldn't save", async () => {
    const server = new FakeServer("a");
    server.failBefore = 1;
    const { saver } = saverFor(server);
    saver.schedule("ab");
    await expect(saver.flush()).rejects.toThrow("haven't saved");
  });
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
    expect(save).toHaveBeenCalledExactlyOnceWith("ab", false);
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
    expect(errors).toEqual(["offline", "offline"]);
  });

  it("flushes a pending value on request, and reports failure", async () => {
    const save = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline"));
    const saver = new LatestSaver<string>(save, 500, () => {});
    saver.schedule("sample");
    await saver.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith("sample", false);
    saver.schedule("other");
    await expect(saver.flush()).rejects.toThrow("Couldn't save");
  });

  it("sends a pending value straight away as the page is hidden", async () => {
    const save = vi.fn().mockResolvedValue(null);
    const saver = new LatestSaver<string>(save, 500, () => {});
    saver.schedule("cursor");
    saver.flushOnExit();
    expect(save).toHaveBeenCalledExactlyOnceWith("cursor", true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
