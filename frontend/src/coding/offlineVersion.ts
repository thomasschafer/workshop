import type { OutboxEvent } from "../offline/outbox";

/**
 * The server session version expected after every queued coding outbox event for `itemKey` is
 * replayed in order on top of `baseVersion`.
 */
export function expectedVersionAfterOutbox(
  itemKey: string,
  baseVersion: number,
  events: readonly OutboxEvent[],
): number {
  let version = baseVersion;
  for (const ev of events) {
    if (ev.kind !== "coding_event" || ev.event.item !== itemKey) continue;
    switch (ev.event.kind) {
      case "session_opened":
        version = Math.max(version, 1);
        break;
      case "session_updated":
      case "submitted":
        version = Math.max(version, ev.event.base_version + 1);
        break;
      case "finished":
        break;
    }
  }
  return version;
}

/**
 * Tracks a coding problem's last server-confirmed session version alongside the version expected
 * after any unapplied offline outbox events (both `session_updated` and local `submitted`), so
 * offline events form a monotonic chain without false 409 conflicts on sync.
 */
export class CodingSessionVersions {
  confirmed = 0;
  localExpected = 0;

  constructor(readonly itemKey: string) {}

  /** Resets from an opened session (online or from cache), accounting for any queued outbox events. */
  reset(confirmedVersion: number, outboxEvents: readonly OutboxEvent[]): void {
    this.confirmed = confirmedVersion;
    this.localExpected = expectedVersionAfterOutbox(this.itemKey, confirmedVersion, outboxEvents);
  }

  /** Adopts a newer server-confirmed version once an online save or synced outbox event lands. */
  confirm(version: number, outboxEvents: readonly OutboxEvent[]): void {
    if (version > this.confirmed) this.confirmed = version;
    this.localExpected = expectedVersionAfterOutbox(this.itemKey, this.confirmed, outboxEvents);
  }

  /** The `base_version` to attach to the next offline `session_updated` or local `submitted` event. */
  nextBaseVersion(fallbackVersion: number): number {
    return this.localExpected || this.confirmed || fallbackVersion;
  }

  /** Advances `localExpected` after enqueueing an offline `session_updated` event. */
  recordOfflineUpdate(baseVersion: number, coalesced: boolean): void {
    if (!coalesced) this.localExpected = baseVersion + 1;
  }

  /** Advances `localExpected` after enqueueing a local `submitted` event. */
  recordOfflineSubmit(baseVersion: number): void {
    this.localExpected = baseVersion + 1;
  }
}
