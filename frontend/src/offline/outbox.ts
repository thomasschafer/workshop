// Synchronous, strictly ordered localStorage outbox for small offline events (mistake tags and
// coding session events). Flushed through the unified `POST /api/sync` endpoint, either standalone
// or piggybacked on `Learning.sync()` so everything lands in one idempotent request.
//
// Re-reads storage before every mutation and listens for cross-tab `storage` events so multiple
// tabs never overwrite each other's queued events, and persists sync conflicts/errors durably.

import {
  ApiError,
  ConnectionError,
  connection,
  onNetworkOnline,
  request,
  TimeoutError,
} from "../api";
import type { Graded, Language, Mode, Session } from "../coding/types";
import { errorMessage } from "../errors";
import { newId, utcOffset } from "../learning/local";
import type { Deck, Rating } from "../learning/types";

const STORAGE_KEY = "workshop:outbox";
const ISSUES_KEY = "workshop:outbox:issues";
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
      part?: number | undefined;
      graded: Graded | null;
      at: number;
    }
  | {
      kind: "finished";
      id: string;
      item: string;
      base_version: number | null;
      started_at?: number;
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

export interface OutboxIssue {
  id: string;
  kind: "conflict" | "error";
  item: string;
  message: string;
  current?: Session;
  at: number;
}

export interface OutboxBatch {
  ids: Set<string>;
  coding_events: CodingOutboxPayload[];
  mistake_tags: { id: string; mistake_id: string; error_type: string | null }[];
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof ConnectionError || err instanceof TimeoutError) return true;
  if (err instanceof ApiError) {
    return err.status >= 500 || err.status === 401 || err.status === 408 || err.status === 429;
  }
  return false;
}

export class Outbox {
  private events: OutboxEvent[];
  private savedIssues: OutboxIssue[];
  private readonly listeners = new Set<() => void>();
  private readonly sessionListeners = new Set<(item: string, session: Session) => void>();
  private readonly inFlightIds = new Set<string>();
  private batchInFlight = false;
  private running: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RETRY_MS;

  constructor(
    private readonly storage: Storage | null = typeof localStorage === "undefined"
      ? null
      : localStorage,
  ) {
    this.events = this.loadEvents();
    this.savedIssues = this.loadIssues();
  }

  private loadEvents(): OutboxEvent[] {
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

  private loadIssues(): OutboxIssue[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(ISSUES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as OutboxIssue[]) : [];
    } catch {
      return [];
    }
  }

  private saveEvents(): void {
    if (this.storage) {
      try {
        this.storage.setItem(STORAGE_KEY, JSON.stringify(this.events));
      } catch {
        // Storage unavailable; keep in memory so sync can still proceed.
      }
    }
    this.notify();
  }

  private saveIssues(): void {
    if (this.storage) {
      try {
        this.storage.setItem(ISSUES_KEY, JSON.stringify(this.savedIssues));
      } catch {
        // Storage unavailable; keep in memory.
      }
    }
    this.notify();
  }

  /** Reloads from shared storage when another tab writes to the outbox. */
  syncFromStorage(): void {
    this.events = this.loadEvents();
    this.savedIssues = this.loadIssues();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get pending(): number {
    if (this.storage) this.events = this.loadEvents();
    return this.events.length;
  }

  list(): readonly OutboxEvent[] {
    if (this.storage) this.events = this.loadEvents();
    return this.events;
  }

  issues(): readonly OutboxIssue[] {
    if (this.storage) this.savedIssues = this.loadIssues();
    return this.savedIssues;
  }

  conflictFor(item: string): Session | null {
    const issue = this.issues().find((i) => i.kind === "conflict" && i.item === item);
    return issue?.current ?? null;
  }

  clearConflict(item: string): void {
    this.savedIssues = this.loadIssues().filter((i) => !(i.kind === "conflict" && i.item === item));
    this.saveIssues();
  }

  dismissIssue(id: string): void {
    this.savedIssues = this.loadIssues().filter((i) => i.id !== id);
    this.saveIssues();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls `listener` whenever the outbox applies an updated server session for `item`. */
  onSessionApplied(item: string, listener: (session: Session) => void): () => void {
    const wrapped = (appliedItem: string, session: Session) => {
      if (appliedItem === item) listener(session);
    };
    this.sessionListeners.add(wrapped);
    return () => this.sessionListeners.delete(wrapped);
  }

  /** Whether any coding session event for `item` is currently queued or in flight. */
  hasPendingCodingEvents(item: string): boolean {
    return this.list().some((ev) => ev.kind === "coding_event" && ev.event.item === item);
  }

  /** Drops any queued (not-yet-in-flight) `session_updated` events for `item` once a live online
   * PUT has persisted the full latest session. */
  dropUnsentSessionUpdates(item: string): void {
    const current = this.storage ? this.loadEvents() : this.events;
    const filtered = current.filter(
      (ev) =>
        !(
          ev.kind === "coding_event" &&
          ev.event.kind === "session_updated" &&
          ev.event.item === item &&
          !this.inFlightIds.has(ev.id)
        ),
    );
    if (filtered.length !== current.length) {
      this.events = filtered;
      this.saveEvents();
    }
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
    const current = this.storage ? this.loadEvents() : this.events;
    this.events = [
      ...current.filter(
        (e) =>
          !(e.kind === "mistake_tag" && e.mistakeId === mistakeId && !this.inFlightIds.has(e.id)),
      ),
      event,
    ];
    this.saveEvents();
    void this.flush();
    return event;
  }

  /**
   * Queues a coding session event. Consecutive unsent `session_updated` events for the same item
   * (not currently in flight) are coalesced into one, keeping the earlier event's `base_version`.
   * Returns whether this replaced an existing queued update.
   */
  enqueueCodingEvent(
    payload: CodingOutboxPayload,
    autoFlush = true,
  ): { event: OutboxEvent; coalesced: boolean } {
    const wrapped: OutboxEvent = {
      kind: "coding_event",
      id: payload.id,
      event: payload,
      at: Date.now(),
    };
    const current = this.storage ? this.loadEvents() : [...this.events];
    if (payload.kind === "session_updated") {
      const last = current.at(-1);
      if (
        last?.kind === "coding_event" &&
        last.event.kind === "session_updated" &&
        last.event.item === payload.item &&
        !this.inFlightIds.has(last.id)
      ) {
        // Keep the earlier base_version so the coalesced update still applies cleanly on top of
        // the server's version before this offline edit burst began.
        const coalescedEvent: OutboxEvent = {
          ...wrapped,
          event: { ...payload, base_version: last.event.base_version },
        };
        current[current.length - 1] = coalescedEvent;
        this.events = current;
        this.saveEvents();
        if (autoFlush) void this.flush();
        return { event: coalescedEvent, coalesced: true };
      }
    }
    current.push(wrapped);
    this.events = current;
    this.saveEvents();
    if (autoFlush) void this.flush();
    return { event: wrapped, coalesced: false };
  }

  /**
   * Claims the current pending events for a single unified `POST /api/sync` sender, returning
   * null if another sender already owns a batch or the outbox is empty. Callers must call either
   * `applySyncResults` or `releaseBatch` when finished.
   */
  tryAcquireBatch(): OutboxBatch | null {
    if (this.batchInFlight) return null;
    if (this.storage) this.events = this.loadEvents();
    if (this.events.length === 0) return null;
    this.batchInFlight = true;
    const ids = new Set<string>();
    const coding_events: CodingOutboxPayload[] = [];
    const mistake_tags: { id: string; mistake_id: string; error_type: string | null }[] = [];
    for (const ev of this.events) {
      ids.add(ev.id);
      this.inFlightIds.add(ev.id);
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

  /** Releases an acquired batch after a retryable failure so a later sync can resend it. */
  releaseBatch(batch: OutboxBatch): void {
    for (const id of batch.ids) this.inFlightIds.delete(id);
    this.batchInFlight = false;
  }

  /** Applies the server's per-event outcomes from a unified `POST /api/sync` response. */
  applySyncResults(batch: OutboxBatch, response: UnifiedSyncResponse): void {
    const issues = this.storage ? this.loadIssues() : [...this.savedIssues];
    const appliedSessions = new Map<string, Session>();
    const now = Date.now();
    for (const outcome of response.coding_results) {
      if (outcome.status === "applied" && outcome.session) {
        appliedSessions.set(outcome.item, outcome.session);
      } else if (outcome.status === "conflict" && outcome.current) {
        const filtered = issues.filter((i) => !(i.kind === "conflict" && i.item === outcome.item));
        issues.length = 0;
        issues.push(...filtered, {
          id: outcome.id,
          kind: "conflict",
          item: outcome.item,
          message: "Edited on another device while offline.",
          current: outcome.current,
          at: now,
        });
      } else if (outcome.status === "error") {
        issues.push({
          id: outcome.id,
          kind: "error",
          item: outcome.item,
          message: outcome.message ?? "Server refused this coding update.",
          at: now,
        });
      }
    }
    this.savedIssues = issues.slice(-50);
    if (this.storage) {
      try {
        this.storage.setItem(ISSUES_KEY, JSON.stringify(this.savedIssues));
      } catch {
        // Ignore storage write failure.
      }
    }

    const current = this.storage ? this.loadEvents() : this.events;
    this.events = current.filter((e) => !batch.ids.has(e.id));
    this.releaseBatch(batch);
    this.retryMs = RETRY_MS;
    this.saveEvents();

    for (const [item, session] of appliedSessions) {
      for (const listener of this.sessionListeners) listener(item, session);
    }
  }

  flushIfPending(): void {
    if (this.pending > 0) void this.flush();
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
    const batch = this.tryAcquireBatch();
    if (!batch) return;
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
      if (this.pending > 0) void this.flush();
    } catch (e) {
      if (isRetryableError(e)) {
        this.releaseBatch(batch);
        this.retry = setTimeout(() => void this.flush(), this.retryMs);
        this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
        return;
      }
      // Permanent 4xx validation refusal: record in durable issues so it isn't lost silently,
      // and drop only this batch so later events aren't blocked.
      const issues = this.storage ? this.loadIssues() : [...this.savedIssues];
      issues.push({
        id: newId(),
        kind: "error",
        item: "sync",
        message: `Offline sync batch was rejected: ${errorMessage(e)}`,
        at: Date.now(),
      });
      this.savedIssues = issues.slice(-50);
      this.saveIssues();
      const current = this.storage ? this.loadEvents() : this.events;
      this.events = current.filter((ev) => !batch.ids.has(ev.id));
      this.releaseBatch(batch);
      this.saveEvents();
    }
  }
}

let shared: Outbox | null = null;

export function outbox(): Outbox {
  if (!shared) {
    const created = new Outbox();
    connection.subscribe((online) => online && created.flushIfPending());
    if (typeof window !== "undefined") {
      onNetworkOnline(() => created.flushIfPending());
      window.addEventListener("storage", (ev) => {
        if (ev.key === STORAGE_KEY || ev.key === ISSUES_KEY) created.syncFromStorage();
      });
    }
    shared = created;
  }
  return shared;
}
