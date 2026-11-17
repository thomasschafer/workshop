import { ApiError } from "./api";
import { errorMessage } from "./errors";

export type SaveStatus = "saved" | "pending" | "saving" | "conflict" | "error";

/** A file as the server has it. */
export interface FileVersion {
  text: string;
  version: string;
}

/**
 * When a read of the file from the server began, from `VersionedSaver.readMark`, so `adopt` can
 * tell whether one of the saver's own saves may have landed since.
 */
export type ReadMark = number & { readonly __readMark: unique symbol };

/** Saves `text` if the file is still at `version`, rejecting with a 409 `ApiError` if not. */
export type SaveFile = (text: string, version: string, keepalive: boolean) => Promise<FileVersion>;

interface Unsaved {
  text: string;
  /** The version the unsaved text was based on. */
  base: string;
}

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;
/** Texts sent recently, so a conflict caused by one of our own earlier saves is recognised. */
const REMEMBERED_SENDS = 20;

/**
 * Saves a file the user edits, shortly after each change and one request at a time.
 *
 * Nothing is lost if the phone is put down or the page reloads: until the server confirms a
 * save, the text is also kept in local storage, and `recover` picks it up again. A file changed
 * elsewhere (say, at a desk) is never overwritten silently: saving stops, and the user chooses
 * between `keepMine` and `takeTheirs`.
 */
export class VersionedSaver {
  /** The most recent text, saved or not. */
  private latest: string;
  /** The text the server has confirmed. */
  private confirmed: string;
  private pending: string | null = null;
  private readonly sent: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private conflicted = false;
  private closed = false;
  private retryDelay = MIN_RETRY_MS;
  /** How many times the version has changed, so a read can tell whether it's out of date. */
  private versionChanges = 0;

  constructor(
    private readonly saveFile: SaveFile,
    private readonly storageKey: string,
    private version: string,
    text: string,
    private readonly onStatus: (status: SaveStatus, detail?: string) => void,
    private readonly onConflict: (theirs: FileVersion) => void,
  ) {
    this.latest = text;
    this.confirmed = text;
  }

  /**
   * Restores text that was never confirmed as saved, for example because the page was closed
   * first. Returns the text to show: the unsaved text if there is any, otherwise the file's.
   */
  recover(): string {
    const unsaved = this.readUnsaved();
    if (unsaved === null || unsaved.text === this.confirmed) {
      this.clearUnsaved();
      return this.confirmed;
    }
    this.latest = unsaved.text;
    if (unsaved.base === this.version) {
      this.queue(unsaved.text);
    } else {
      // The file changed elsewhere after these edits were made.
      this.enterConflict({ text: this.confirmed, version: this.version });
    }
    return unsaved.text;
  }

  get hasUnsavedChanges(): boolean {
    return this.latest !== this.confirmed;
  }

  schedule(text: string): void {
    // Such as when a version from elsewhere is shown: saving it back would only race with the
    // next change made there.
    if (this.closed || text === this.latest) return;
    this.latest = text;
    this.writeUnsaved();
    if (this.conflicted) return;
    this.queue(text);
  }

  /** Saves now, resolving once the latest text is on disk and rejecting if it isn't. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    const text = this.pending;
    if (text !== null && !this.conflicted) {
      this.pending = null;
      this.chain = this.chain.then(() => this.attempt(text, false));
    }
    await this.chain;
    if (this.conflicted) {
      throw new Error("This file changed elsewhere; choose which version to keep first.");
    }
    if (this.hasUnsavedChanges) {
      throw new Error("Your latest changes haven't saved yet; check the connection and try again.");
    }
  }

  /** Sends any unsaved text while the page is being hidden, in a request that outlives it. */
  flushOnExit(): void {
    clearTimeout(this.timer);
    const text = this.pending;
    if (text === null || this.conflicted) return;
    this.pending = null;
    // Not chained: the page may be frozen at any moment. A conflict with an earlier request is
    // recognised as our own when the response arrives.
    void this.attempt(text, true);
  }

  /** Overwrites the version from elsewhere with the local text. */
  keepMine(theirs: FileVersion): void {
    this.setConfirmed(theirs);
    this.conflicted = false;
    if (this.hasUnsavedChanges) {
      this.queue(this.latest);
      void this.flush().catch(() => {});
    } else {
      this.markSaved();
    }
  }

  /** Discards local changes in favour of the version from elsewhere. */
  takeTheirs(theirs: FileVersion): void {
    this.setConfirmed(theirs);
    this.latest = theirs.text;
    this.pending = null;
    this.conflicted = false;
    this.markSaved();
  }

  /** Marks a read of the file from the server beginning, to give `adopt` with what it read. */
  readMark(): ReadMark {
    return this.versionChanges as ReadMark;
  }

  /**
   * Takes a newer version of the file from elsewhere if there are no local changes, returning
   * whether it did. Otherwise the local changes are saved, which reports a conflict if needed.
   * `since` is when the read that found `theirs` began.
   */
  adopt(theirs: FileVersion, since: ReadMark): boolean {
    if (theirs.version === this.version) return false;
    // A save of ours landed after the read began, which may have read the file before it: what
    // was read can be older than what's saved, rather than from elsewhere. The next read tells.
    if (since !== this.versionChanges) return false;
    if (!this.hasUnsavedChanges && !this.conflicted) {
      this.takeTheirs(theirs);
      return true;
    }
    if (!this.conflicted) {
      this.queue(this.latest);
    }
    return false;
  }

  close(): void {
    this.flushOnExit();
    this.closed = true;
  }

  private queue(text: string): void {
    this.pending = text;
    this.onStatus("pending");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => {}), 400);
  }

  private async attempt(text: string, keepalive: boolean): Promise<void> {
    if (this.conflicted) return;
    this.remember(text);
    this.onStatus("saving");
    try {
      const saved = await this.saveFile(text, this.version, keepalive);
      // The server may have added a final newline, but what it saved is still this text.
      this.confirm({ text, version: saved.version });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const theirs = (err.body as { current?: FileVersion } | null)?.current;
        if (!theirs) {
          this.enterConflict({ text: this.confirmed, version: this.version });
          return;
        }
        const ours = this.sentAs(theirs.text);
        if (ours !== undefined) {
          // One of our own saves landed first, for example one sent as the page was hidden.
          this.confirm({ text: ours, version: theirs.version });
        } else {
          this.enterConflict(theirs);
        }
        return;
      }
      this.pending ??= this.latest;
      this.onStatus("error", errorMessage(err));
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush().catch(() => {}), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
    }
  }

  private confirm(file: FileVersion): void {
    this.setConfirmed(file);
    this.retryDelay = MIN_RETRY_MS;
    if (this.hasUnsavedChanges) {
      this.writeUnsaved();
      if (this.pending === null) this.queue(this.latest);
      this.onStatus("pending");
    } else {
      this.markSaved();
    }
  }

  private setConfirmed(file: FileVersion): void {
    if (file.version !== this.version) this.versionChanges++;
    this.version = file.version;
    this.confirmed = file.text;
  }

  private enterConflict(theirs: FileVersion): void {
    this.conflicted = true;
    this.pending = null;
    clearTimeout(this.timer);
    this.writeUnsaved();
    this.onStatus("conflict");
    this.onConflict(theirs);
  }

  private markSaved(): void {
    this.clearUnsaved();
    this.onStatus("saved");
  }

  /** The recently sent text that the server saved as `saved`, which may add a final newline. */
  private sentAs(saved: string): string | undefined {
    return this.sent.find((text) => text === saved || `${text}\n` === saved);
  }

  private remember(text: string): void {
    this.sent.push(text);
    if (this.sent.length > REMEMBERED_SENDS) this.sent.shift();
  }

  private readUnsaved(): Unsaved | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      const value = raw === null ? null : (JSON.parse(raw) as Partial<Unsaved>);
      return typeof value?.text === "string" && typeof value.base === "string"
        ? { text: value.text, base: value.base }
        : null;
    } catch {
      return null;
    }
  }

  private writeUnsaved(): void {
    if (!this.hasUnsavedChanges) {
      this.clearUnsaved();
      return;
    }
    const unsaved: Unsaved = { text: this.latest, base: this.version };
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(unsaved));
    } catch {
      // Storage can be full or disabled; the server save is still attempted.
    }
  }

  private clearUnsaved(): void {
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      // As above.
    }
  }
}

/**
 * Saves the latest value once changes pause, retrying until it succeeds, so nothing is lost
 * if the server is briefly unreachable. Only the most recent value is ever sent.
 */
export class LatestSaver<T> {
  /** The value waiting to be sent, with how many values had been scheduled when it was. */
  private latest: { value: T; count: number } | null = null;
  private scheduled = 0;
  /** The count of the newest value the server has confirmed. */
  private landed = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  /** Saves sent as the page was hidden, which aren't one at a time with the rest. */
  private readonly exiting = new Set<Promise<void>>();
  private retryDelay = MIN_RETRY_MS;

  constructor(
    private readonly save: (value: T, keepalive: boolean) => Promise<unknown>,
    private readonly delayMs: number,
    private readonly onError: (message: string) => void,
  ) {}

  schedule(value: T): void {
    this.scheduled++;
    this.latest = { value, count: this.scheduled };
    this.wait(this.delayMs);
  }

  /**
   * Saves any pending value now, resolving once the server has it, or a newer one, and
   * rejecting if it couldn't be saved.
   */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    const wanted = this.scheduled;
    let tried = false;
    while (this.landed < wanted) {
      // A save already on its way may be this value, or one before it, sent by the timer or
      // another flush; either way, what's still pending can only be sent after it.
      const underWay = this.saving ?? this.exiting.values().next().value;
      if (underWay) {
        await underWay;
        continue;
      }
      if (tried || this.latest === null) {
        throw new Error("Couldn't save; check the connection and try again.");
      }
      tried = true;
      await this.run();
    }
  }

  /** Sends any pending value while the page is being hidden, in a request that outlives it. */
  flushOnExit(): void {
    if (this.latest === null) return;
    clearTimeout(this.timer);
    const pending = this.latest;
    this.latest = null;
    const sent: Promise<void> = this.save(pending.value, true)
      .then(
        () => this.confirm(pending.count),
        () => {
          this.latest ??= pending;
          this.wait(this.retryDelay);
        },
      )
      .finally(() => this.exiting.delete(sent));
    this.exiting.add(sent);
  }

  private confirm(count: number): void {
    this.landed = Math.max(this.landed, count);
  }

  private wait(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), ms);
  }

  private run(): Promise<void> {
    if (this.saving) return this.saving;
    if (this.latest === null) return Promise.resolve();
    const pending = this.latest;
    this.latest = null;
    this.saving = this.save(pending.value, false)
      .then(() => {
        this.confirm(pending.count);
        this.retryDelay = MIN_RETRY_MS;
        if (this.latest !== null) this.wait(this.delayMs);
      })
      .catch((err: unknown) => {
        this.latest ??= pending;
        this.onError(errorMessage(err));
        this.wait(this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
      })
      .finally(() => {
        this.saving = null;
      });
    return this.saving;
  }
}

/** Calls `save` with the latest value once changes pause. */
export function debounced<T>(save: (value: T) => void, ms: number): (value: T) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (value: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => save(value), ms);
  };
}
