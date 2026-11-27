import { describe, expect, it } from "vitest";
import { type CodingOutboxPayload, Outbox } from "../offline/outbox";
import { CodingSessionVersions, expectedVersionAfterOutbox } from "./offlineVersion";
import type { Session } from "./types";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => data.delete(k),
    setItem: (k: string, v: string) => data.set(k, v),
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    mode: "solve",
    step: "code",
    language: "haskell",
    part: 0,
    plans: [],
    prediction: null,
    plan: "use a set",
    passed: false,
    runs: 0,
    submissions: 0,
    hints: 0,
    no_twist: null,
    started_at: 1000,
    updated_at: 1100,
    version: 1,
    ...overrides,
  };
}

/**
 * Replays coding events using the server's exact monotonic version check from
 * `Problems::save_session_locked` and `Problems::record_submission_locked`.
 */
function replayOnServer(
  initialVersion: number,
  events: readonly CodingOutboxPayload[],
): { statuses: ("applied" | "conflict")[]; finalVersion: number } {
  let version = initialVersion;
  const statuses: ("applied" | "conflict")[] = [];
  for (const ev of events) {
    if (ev.kind === "session_opened") {
      version = Math.max(version, 1);
      statuses.push("applied");
    } else if (ev.kind === "session_updated" || ev.kind === "submitted") {
      if (ev.base_version !== version) {
        statuses.push("conflict");
      } else {
        version += 1;
        statuses.push("applied");
      }
    } else if (ev.kind === "finished") {
      statuses.push("applied");
    }
  }
  return { statuses, finalVersion: version };
}

describe("CodingSessionVersions offline sync ordering", () => {
  it("reproduces the false 409 conflict when submitted uses stale session.version, and avoids it with CodingSessionVersions", () => {
    const item = "sample/first-repeat";
    const storage = memoryStorage();
    const ob = new Outbox(storage);
    const cachedSession = makeSession({ version: 1, step: "understand" });

    // Contrast: sending submitted with stale session.version (1) after session_updated (1 -> 2)
    // triggers a 409 conflict on replay.
    const staleReplay = replayOnServer(1, [
      {
        kind: "session_updated",
        id: "stale-upd",
        item,
        base_version: 1,
        session: { ...cachedSession, step: "code" },
        at: 1200,
      },
      {
        kind: "submitted",
        id: "stale-sub",
        item,
        base_version: cachedSession.version ?? 1,
        passed: true,
        part: 0,
        graded: null,
        at: 1300,
      },
    ]);
    expect(staleReplay.statuses).toEqual(["applied", "conflict"]);

    // With CodingSessionVersions: offline plan/step edit -> local submit -> reload from stale IDB
    // cache -> another edit -> all replay cleanly without conflict.
    const versions = new CodingSessionVersions(item);
    versions.reset(cachedSession.version ?? 1, ob.list());

    // 1. Offline step/plan edit queued as session_updated (coalesced across two edits).
    const base1 = versions.nextBaseVersion(cachedSession.version ?? 1);
    const r1 = ob.enqueueCodingEvent(
      {
        kind: "session_updated",
        id: "upd-1",
        item,
        base_version: base1,
        session: { ...cachedSession, step: "plan", version: base1 },
        at: 1200,
      },
      false,
    );
    versions.recordOfflineUpdate(base1, r1.coalesced);

    const base1b = versions.nextBaseVersion(cachedSession.version ?? 1);
    const r1b = ob.enqueueCodingEvent(
      {
        kind: "session_updated",
        id: "upd-2",
        item,
        base_version: base1b,
        session: { ...cachedSession, step: "code", version: base1b },
        at: 1250,
      },
      false,
    );
    versions.recordOfflineUpdate(base1b, r1b.coalesced);
    expect(r1b.coalesced).toBe(true);
    expect(versions.localExpected).toBe(2);

    // 2. Local on-device submit reads nextBaseVersion (2) and bumps localExpected to 3.
    const submitBase = versions.nextBaseVersion(cachedSession.version ?? 1);
    expect(submitBase).toBe(2);
    ob.enqueueCodingEvent(
      {
        kind: "submitted",
        id: "sub-1",
        item,
        base_version: submitBase,
        passed: true,
        part: 0,
        graded: null,
        at: 1300,
      },
      false,
    );
    versions.recordOfflineSubmit(submitBase);
    expect(versions.localExpected).toBe(3);

    // 3. Page reloads offline while IndexedDB still holds older cached version 1; resetting from
    // cache + outbox derives expected version 3 instead of regressing to 1.
    const reloaded = new CodingSessionVersions(item);
    reloaded.reset(1, ob.list());
    expect(reloaded.localExpected).toBe(3);
    expect(expectedVersionAfterOutbox(item, 1, ob.list())).toBe(3);

    // 4. Subsequent offline edit after reload chains cleanly at base_version 3.
    const base3 = reloaded.nextBaseVersion(1);
    const r3 = ob.enqueueCodingEvent(
      {
        kind: "session_updated",
        id: "upd-3",
        item,
        base_version: base3,
        session: { ...cachedSession, step: "review", passed: true, submissions: 1, version: base3 },
        at: 1400,
      },
      false,
    );
    reloaded.recordOfflineUpdate(base3, r3.coalesced);
    expect(reloaded.localExpected).toBe(4);

    // Replay the whole outbox batch on the server: every event applies cleanly.
    const batch = ob.tryAcquireBatch();
    expect(batch).not.toBeNull();
    const replayed = replayOnServer(1, batch?.coding_events ?? []);
    expect(replayed.statuses).toEqual(["applied", "applied", "applied"]);
    expect(replayed.finalVersion).toBe(4);
  });
});
