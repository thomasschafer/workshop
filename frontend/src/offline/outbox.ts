// Synchronous, strictly ordered localStorage outbox for small offline events (mistake tags, and
// coding session events in the unified sync). Kept next to `workshop:learning` so event ordering
// never splits across two stores.

import { ConnectionError, connection, TimeoutError } from "../api";
import { newId } from "../learning/local";
import { progressApi } from "../progress/api";

const STORAGE_KEY = "workshop:outbox";
const RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

export type OutboxEvent = {
  kind: "mistake_tag";
  id: string;
  mistakeId: string;
  errorType: string | null;
  at: number;
};

export class Outbox {
  private events: OutboxEvent[];
  private readonly listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RETRY_MS;

  constructor(private readonly storage: Storage = localStorage) {
    this.events = this.load();
  }

  private load(): OutboxEvent[] {
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
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.events));
    } catch {
      // Storage unavailable; keep in memory so sync can still proceed.
    }
    for (const listener of this.listeners) listener();
  }

  get pending(): number {
    return this.events.length;
  }

  list(): readonly OutboxEvent[] {
    return this.events;
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
    while (this.events.length > 0) {
      const head = this.events[0];
      if (!head) break;
      try {
        if (head.kind === "mistake_tag") {
          await progressApi.tag(head.mistakeId, head.errorType);
        }
        this.events = this.events.filter((e) => e.id !== head.id);
        this.retryMs = RETRY_MS;
        this.save();
      } catch (e) {
        if (e instanceof ConnectionError || e instanceof TimeoutError) {
          this.retry = setTimeout(() => void this.flush(), this.retryMs);
          this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
          return;
        }
        // A permanent server refusal (e.g. unknown mistake id) shouldn't jam later events.
        this.events = this.events.filter((ev) => ev.id !== head.id);
        this.save();
      }
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
