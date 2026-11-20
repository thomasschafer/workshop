// Synchronous, strictly ordered localStorage outbox for small offline events (mistake tags and
// coding session events). Flushed through the unified `POST /api/sync` endpoint, either standalone
// or piggybacked on `Learning.sync()` so everything lands in one idempotent request.

import { ConnectionError, connection, request, TimeoutError } from "../api";
import type { Graded, Language, Mode, Session } from "../coding/types";
import { newId, utcOffset } from "../learning/local";
import type { Deck, Rating } from "../learning/types";

const STORAGE_KEY = "workshop:outbox";
const RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

export type CodingOutboxPayload =
  | {
      kind: "session_opened";
      id: string;
      item: string;
      mode: Mode;
      language: Language;
      no_twist: string | null;
      started_at: number;
    }
  | {
      kind: "session_updated";
      id: string;
      item: string;
      base_version: number;
      session: Session;
      at: number;
    }
  | {
      kind: "submitted";
      id: string;
      item: string;
      base_version: number;
      passed: boolean;
      graded: Graded | null;
      at: number;
    }
  | {
      kind: "finished";
      id: string;
      item: string;
      base_version: number | null;
      rating: Rating;
      plan: string | null;
      duration_ms: number;
      answered_at: number;
    };

export type OutboxEvent =
  | {
      kind: "mistake_tag";
      id: string;
      mistakeId: string;
      errorType: string | null;
      at: number;
    }
  | {
      kind: "coding_event";
      id: string;
      event: CodingOutboxPayload;
      at: number;
    };

export interface CodingEventOutcome {
  id: string;
  item: string;
  status: "applied" | "duplicate" | "conflict" | "error";
  session?: Session;
  current?: Session;
  message?: string;
}

export interface MistakeTagOutcome {
  id: string;
  ok: boolean;
  error?: string;
}

export interface UnifiedSyncResponse {
  deck: Deck;
  coding_results: CodingEventOutcome[];
  mistake_tag_results: MistakeTagOutcome[];
}

export interface OutboxBatch {
  ids: Set<string>;
  coding_events: CodingOutboxPayload[];
  mistake_tags: { id: string; mistake_id: string; error_type: string | null }[];
}

export class Outbox {
  private events: OutboxEvent[];
  private readonly conflicts = new Map<string, Session>();
  private readonly listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RETRY_MS;

  constructor(
    private readonly storage: Storage | null = typeof localStorage === "undefined"
      ? null
      : localStorage,
  ) {
    this.events = this.load();
  }

  private load(): OutboxEvent[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as OutboxEvent[]) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    if (this.storage) {
      try {
        this.storage.setItem(STORAGE_KEY, JSON.stringify(this.events));
      } catch {
        // Storage unavailable; keep in memory so sync can still proceed.
      }
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get pending(): number {
    return this.events.length;
  }

  list(): readonly OutboxEvent[] {
    return this.events;
  }

  conflictFor(item: string): Session | null {
    return this.conflicts.get(item) ?? null;
  }

  clearConflict(item: string): void {
    if (this.conflicts.delete(item)) this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Queues a mistake tag change; supersedes any earlier unsent tag for the same mistake. */
  enqueueMistakeTag(mistakeId: string, errorType: string | null): OutboxEvent {
    const event: OutboxEvent = {
      kind: "mistake_tag",
      id: newId(),
      mistakeId,
      errorType,
      at: Date.now(),
    };
    this.events = [
      ...this.events.filter((e) => !(e.kind === "mistake_tag" && e.mistakeId === mistakeId)),
      event,
    ];
    this.save();
    void this.flush();
    return event;
  }

  /**
   * Queues a coding session event. Consecutive `session_updated` events for the same item and
   * base version are coalesced so typing a plan offline doesn't bloat the outbox.
   */
  enqueueCodingEvent(payload: CodingOutboxPayload, autoFlush = true): OutboxEvent {
    const wrapped: OutboxEvent = {
      kind: "coding_event",
      id: payload.id,
      event: payload,
      at: Date.now(),
    };
    const next = [...this.events];
    if (payload.kind === "session_updated") {
      const last = next.at(-1);
      if (
        last?.kind === "coding_event" &&
        last.event.kind === "session_updated" &&
        last.event.item === payload.item &&
        last.event.base_version === payload.base_version
      ) {
        next[next.length - 1] = wrapped;
        this.events = next;
        this.save();
        if (autoFlush) void this.flush();
        return wrapped;
      }
    }
    next.push(wrapped);
    this.events = next;
    this.save();
    if (autoFlush) void this.flush();
    return wrapped;
  }

  /** Snapshots pending events to send in a unified `POST /api/sync` call. */
  snapshotBatch(): OutboxBatch {
    const ids = new Set<string>();
    const coding_events: CodingOutboxPayload[] = [];
    const mistake_tags: { id: string; mistake_id: string; error_type: string | null }[] = [];
    for (const ev of this.events) {
      ids.add(ev.id);
      if (ev.kind === "mistake_tag") {
        mistake_tags.push({
          id: ev.id,
          mistake_id: ev.mistakeId,
          error_type: ev.errorType,
        });
      } else {
        coding_events.push(ev.event);
      }
    }
    return { ids, coding_events, mistake_tags };
  }

  /** Applies the server's per-event outcomes from a unified `POST /api/sync` response. */
  applySyncResults(batch: OutboxBatch, response: UnifiedSyncResponse): void {
    const conflictedItems = new Map<string, Session>();
    for (const outcome of response.coding_results) {
      if (outcome.status === "conflict" && outcome.current) {
        conflictedItems.set(outcome.item, outcome.current);
      }
    }
    for (const [item, current] of conflictedItems) {
      this.conflicts.set(item, current);
    }
    // Remove all sent events (applied, duplicate, error, or conflicted so a stale event doesn't
    // jam later syncs; conflicts are surfaced to the user with the server's current session).
    this.events = this.events.filter((e) => !batch.ids.has(e.id));
    this.retryMs = RETRY_MS;
    this.save();
  }

  flushIfPending(): void {
    if (this.events.length > 0) void this.flush();
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.events.length === 0) return;
    const batch = this.snapshotBatch();
    try {
      const response = await request<UnifiedSyncResponse>(
        "POST",
        `/sync?utc_offset=${utcOffset()}`,
        {
          attempts: [],
          flags: [],
          retirements: [],
          coding_events: batch.coding_events,
          mistake_tags: batch.mistake_tags,
        },
      );
      this.applySyncResults(batch, response);
      // If more events arrived while this batch was in flight, flush them too.
      if (this.events.length > 0) void this.flush();
    } catch (e) {
      if (e instanceof ConnectionError || e instanceof TimeoutError) {
        this.retry = setTimeout(() => void this.flush(), this.retryMs);
        this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
        return;
      }
      // Unexpected permanent refusal: drop this batch so it doesn't jam later events.
      this.events = this.events.filter((ev) => !batch.ids.has(ev.id));
      this.save();
    }
  }
}

let shared: Outbox | null = null;

export function outbox(): Outbox {
  if (!shared) {
    const created = new Outbox();
    connection.subscribe((online) => online && created.flushIfPending());
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => created.flushIfPending());
    }
    shared = created;
  }
  return shared;
}
