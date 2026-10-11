import { ApiError, api, type CodeFile, type Puzzle } from "./api";

export type SaveStatus = "saved" | "pending" | "saving" | "conflict" | "error";

/**
 * Saves the code shortly after each change, one request at a time, so nothing is lost if the
 * phone is put down. Stops on a conflict rather than overwriting changes made elsewhere.
 */
export class CodeSaver {
  private pending: string | null = null;
  private timer: number | undefined;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

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
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 400);
  }

  /** Saves any pending change now, resolving once it is on disk. */
  flush(): Promise<void> {
    window.clearTimeout(this.timer);
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
    window.clearTimeout(this.timer);
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
    window.clearTimeout(this.timer);
    this.stopped = true;
  }

  private async save(text: string): Promise<void> {
    if (this.stopped) return;
    this.onStatus("saving");
    try {
      const saved = await api.saveCode(this.puzzle, text, this.version);
      this.version = saved.version;
      this.onStatus(this.pending === null ? "saved" : "pending");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        this.stopped = true;
        this.onStatus("conflict");
        const body = err.body as { current?: CodeFile } | null;
        if (body?.current) this.onConflict(body.current);
        return;
      }
      // Keep the text so the next change or flush retries it.
      this.pending ??= text;
      this.onStatus("error", err instanceof Error ? err.message : String(err));
    }
  }
}

/** Calls `save` with the latest value once changes pause. */
export function debounced<T>(save: (value: T) => void, ms: number): (value: T) => void {
  let timer: number | undefined;
  return (value: T) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => save(value), ms);
  };
}
