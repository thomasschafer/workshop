// The deck and everything done since it came, kept on the device so practice works offline, and
// sent to the server whenever it can be reached. Each attempt and change has its own id, so
// sending one again after a reply was lost changes nothing.

import {
  ApiError,
  ConnectionError,
  connection,
  onNetworkOnline,
  request,
  TimeoutError,
} from "../api";
import { errorMessage } from "../errors";
import { outbox, type UnifiedSyncResponse } from "../offline/outbox";
import { newId, utcOffset } from "./local";
import type { Attempt, Deck, FlagChange, RetirementChange } from "./types";

const STORAGE_KEY = "workshop:learning";

/** How long to wait before trying the server again, at first and at most. */
const RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

interface Saved {
  deck: Deck | null;
  /** Done since the deck came, and not yet known to have reached the server. */
  attempts: Attempt[];
  flags: FlagChange[];
  /** Missing from what an older Workshop saved on the device. */
  retirements?: RetirementChange[];
}

export interface SyncStatus {
  /** How many attempts and changes are waiting to reach the server. A retirement goes with the
   * attempt that made it, so the two count as one. */
  pending: number;
  syncing: boolean;
  /** Whether the server couldn't be reached the last time it was tried. */
  offline: boolean;
  /** What the server said was wrong, the last time it refused what was sent. */
  error: string | null;
}

export class Learning {
  private saved: Saved;
  private status: SyncStatus = { pending: 0, syncing: false, offline: false, error: null };
  private readonly listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  /** The sync to follow the one under way, which every sync asked for meanwhile waits for. */
  private following: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RETRY_MS;

  constructor(private readonly storage: Storage = localStorage) {
    this.saved = this.load();
    this.status.pending = this.pending();
  }

  private load(): Saved {
    const text = this.storage.getItem(STORAGE_KEY);
    if (!text) return { deck: null, attempts: [], flags: [] };
    // Anything else here was written by this code, so a failure to read it is a bug to hear about.
    return JSON.parse(text) as Saved;
  }

  private save(): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(this.saved));
    this.status = { ...this.status, pending: this.pending() };
    for (const listener of this.listeners) listener();
  }

  /** Syncs now if anything is waiting, such as when the server can be reached again. */
  syncIfPending(): void {
    if (this.pending() > 0) void this.sync();
  }

  private pending(): number {
    const attempts = new Set(this.saved.attempts.map((a) => a.id));
    const changes = this.retirementChanges.filter((change) => !attempts.has(change.id));
    return this.saved.attempts.length + this.saved.flags.length + changes.length;
  }

  get deck(): Deck | null {
    return this.saved.deck;
  }

  get attempts(): Attempt[] {
    return this.saved.attempts;
  }

  get flagChanges(): FlagChange[] {
    return this.saved.flags;
  }

  get retirementChanges(): RetirementChange[] {
    return this.saved.retirements ?? [];
  }

  get syncStatus(): SyncStatus {
    return this.status;
  }

  /** Calls `listener` whenever anything here changes, returning how to stop. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(change: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...change };
    for (const listener of this.listeners) listener();
  }

  /** Saves an attempt on the device straight away, then sends it when it can. */
  record(attempt: Attempt): void {
    this.saved = { ...this.saved, attempts: [...this.saved.attempts, attempt] };
    this.save();
    void this.sync();
  }

  flag(change: FlagChange): void {
    this.saved = { ...this.saved, flags: [...this.saved.flags, change] };
    this.save();
    void this.sync();
  }

  /** Saves an attempt, rated easy, and the retirement it makes, together, then sends both. */
  retire(attempt: Attempt): void {
    if (attempt.rating !== "easy") {
      throw new Error(`retiring ${attempt.item} needs an attempt rated easy`);
    }
    const change: RetirementChange = {
      id: attempt.id,
      item: attempt.item,
      at: attempt.answered_at,
      retired: true,
    };
    this.saved = {
      ...this.saved,
      attempts: [...this.saved.attempts, attempt],
      retirements: [...this.retirementChanges, change],
    };
    this.save();
    void this.sync();
  }

  /** Brings a retired item back, due from now. */
  bringBack(item: string, at: number = Date.now()): void {
    const change: RetirementChange = { id: newId(), item, at, retired: false };
    this.saved = { ...this.saved, retirements: [...this.retirementChanges, change] };
    this.save();
    void this.sync();
  }

  /**
   * Sends what's waiting and takes the deck the server sends back. Resolves once that's done or
   * has failed: failures are kept in the status, and tried again later.
   */
  sync(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
      return this.running;
    }
    // The sync under way took what to send as it started, so what's been done since goes in
    // another straight after it.
    this.following ??= this.running.then(() => {
      this.following = null;
      return this.pending() > 0 ? this.sync() : undefined;
    });
    return this.following;
  }

  private async run(): Promise<void> {
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    const attempts = this.saved.attempts;
    const flags = this.saved.flags;
    const retirements = this.retirementChanges;
    const pendingOutbox =
      typeof localStorage !== "undefined" && this.storage === localStorage ? outbox() : null;
    const outboxBatch = pendingOutbox ? pendingOutbox.tryAcquireBatch() : null;
    let outboxSettled = false;
    this.setStatus({ syncing: true });
    try {
      let deck: Deck;
      if (outboxBatch && pendingOutbox) {
        const unified = await request<UnifiedSyncResponse>(
          "POST",
          `/sync?utc_offset=${utcOffset()}`,
          {
            attempts,
            flags,
            retirements,
            coding_events: outboxBatch.coding_events,
            mistake_tags: outboxBatch.mistake_tags,
          },
        );
        pendingOutbox.applySyncResults(outboxBatch, unified);
        outboxSettled = true;
        deck = unified.deck;
      } else {
        deck = await request<Deck>("POST", `/learning/sync?utc_offset=${utcOffset()}`, {
          attempts,
          flags,
          retirements,
        });
      }
      // Anything done while this was on its way is still to send.
      const sentAttempts = new Set(attempts.map((a) => a.id));
      const sentFlags = new Set(flags.map((f) => f.id));
      const sentRetirements = new Set(retirements.map((r) => r.id));
      this.saved = {
        deck,
        attempts: this.saved.attempts.filter((a) => !sentAttempts.has(a.id)),
        flags: this.saved.flags.filter((f) => !sentFlags.has(f.id)),
        retirements: this.retirementChanges.filter((r) => !sentRetirements.has(r.id)),
      };
      this.retryMs = RETRY_MS;
      this.save();
      this.setStatus({ syncing: false, offline: false, error: null });
    } catch (e) {
      if (outboxBatch && pendingOutbox && !outboxSettled) {
        pendingOutbox.releaseBatch(outboxBatch);
      }
      const offline = e instanceof ConnectionError;
      const slow = e instanceof TimeoutError;
      this.setStatus({
        syncing: false,
        offline: offline || slow,
        // What was sent is kept, so nothing done is lost, and the problem is shown until fixed.
        error: offline || slow ? null : e instanceof ApiError ? e.message : errorMessage(e),
      });
      if (offline || slow) {
        this.retry = setTimeout(() => void this.sync(), this.retryMs);
        this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
      }
    }
  }
}

let shared: Learning | null = null;

/** The device's learning, shared by every screen. */
export function learning(): Learning {
  if (!shared) {
    const created = new Learning();
    // Straight away when the server or the network is back, rather than at the next retry.
    connection.subscribe((online) => online && created.syncIfPending());
    onNetworkOnline(() => created.syncIfPending());
    shared = created;
  }
  return shared;
}
