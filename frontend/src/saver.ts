import { ApiError, api, type CodeFile, type Puzzle } from "./api";

export type SaveStatus = "saved" | "pending" | "saving" | "conflict" | "error";

/**
 * Saves the code shortly after each change, one request at a time, so nothing is lost if the
 * phone is put down. Stops on a conflict rather than overwriting changes made elsewhere.
 */
export class CodeSaver {
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private retryDelay = MIN_RETRY_MS;

  constructor(
    private readonly puzzle: Puzzle,
    private version: string,
    private readonly onStatus: (status: SaveStatus, detail?: string) => void,
    private readonly onConflict: (current: CodeFile) => void,
  ) {}

  schedule(text: string): void {
    if (this.stopped) return;
    this.pending = text;
    this.onStatus("pending");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 400);
  }

  /** Saves any pending change now, resolving once it is on disk. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    const text = this.pending;
    if (text === null || this.stopped) {
      return this.chain;
    }
    this.pending = null;
    this.chain = this.chain.then(() => this.save(text));
    return this.chain;
  }

  /** Best-effort save when the page is being hidden or closed. */
  flushOnExit(): void {
    clearTimeout(this.timer);
    const text = this.pending;
    if (text === null || this.stopped) return;
    this.pending = null;
    void fetch(`/api/puzzles/${this.puzzle.year}/${this.puzzle.day}/code`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, version: this.version }),
      keepalive: true,
    });
  }

  /** After the user resolves a conflict by taking the version on disk. */
  resume(version: string): void {
    this.version = version;
    this.stopped = false;
    this.onStatus("saved");
  }

  stop(): void {
    clearTimeout(this.timer);
    this.stopped = true;
  }

  private async save(text: string): Promise<void> {
    if (this.stopped) return;
    this.onStatus("saving");
    try {
      const saved = await api.saveCode(this.puzzle, text, this.version);
      this.saved(saved.version);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { current?: CodeFile } | null;
        // An earlier attempt may have saved before its response was lost, for example when
        // the server restarted.
        if (body?.current?.text === text) {
          this.saved(body.current.version);
          return;
        }
        this.stopped = true;
        this.onStatus("conflict");
        if (body?.current) this.onConflict(body.current);
        return;
      }
      this.pending ??= text;
      this.onStatus("error", err instanceof Error ? err.message : String(err));
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
    }
  }

  private saved(version: string): void {
    this.version = version;
    this.retryDelay = MIN_RETRY_MS;
    this.onStatus(this.pending === null ? "saved" : "pending");
  }
}

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;

/**
 * Saves the latest value once changes pause, retrying until it succeeds, so nothing is lost
 * if the server is briefly unreachable. Only the most recent value is ever sent.
 */
export class LatestSaver<T> {
  private latest: { value: T } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving = false;
  private retryDelay = MIN_RETRY_MS;

  constructor(
    private readonly save: (value: T) => Promise<unknown>,
    private readonly delayMs: number,
    private readonly onError: (message: string) => void,
  ) {}

  schedule(value: T): void {
    this.latest = { value };
    this.wait(this.delayMs);
  }

  private wait(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), ms);
  }

  private async run(): Promise<void> {
    if (this.saving || this.latest === null) return;
    const { value } = this.latest;
    this.latest = null;
    this.saving = true;
    try {
      await this.save(value);
      this.retryDelay = MIN_RETRY_MS;
    } catch (err) {
      this.latest ??= { value };
      this.onError(err instanceof Error ? err.message : String(err));
      this.wait(this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
      return;
    } finally {
      this.saving = false;
    }
    if (this.latest !== null) this.wait(this.delayMs);
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
