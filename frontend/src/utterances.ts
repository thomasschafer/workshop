/** Where an utterance is up to, or a notice from elsewhere in the app. */
export type CardStatus =
  | { kind: "waiting" }
  | { kind: "working"; label: string; since: number }
  /** Finished, and leaves by itself. */
  | { kind: "done"; text: string; tone: "ok" | "info" }
  /** The model needs an answer before it can edit. */
  | { kind: "asked"; question: string }
  /** Stays until dismissed. */
  | { kind: "problem"; text: string; tone: "warn" | "error" };

export interface Card {
  id: number;
  /** What was said, or null for a notice that isn't about an utterance. */
  transcript: string | null;
  status: CardStatus;
  /** Animating away, before it's removed. */
  leaving: boolean;
}

/** How an utterance's handling ended. */
export type Outcome =
  | Extract<CardStatus, { kind: "done" | "asked" | "problem" }>
  /** Cancelled by the user: the card just leaves. */
  | { kind: "cancelled" };

export interface Job<T> {
  id: number;
  text: string;
  /** Whatever else the handler needs, such as where the cursor was when it was spoken. */
  detail: T;
}

export interface JobContext {
  /** Aborted when the user cancels the utterance. */
  signal: AbortSignal;
  /** Shows that the utterance is being worked on, such as "Editing". */
  working: (label: string) => void;
}

export interface Timing {
  /** How long a finished card stays, so its result can be read. */
  lingerMs: number;
  /** How long a card takes to animate away. */
  leaveMs: number;
}

export const TIMING: Timing = { lingerMs: 2500, leaveMs: 220 };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Utterances, handled one at a time in the order they were spoken, each shown as a card. New
 * ones can be added while others are waiting or being worked on, and any can be cancelled.
 */
export class UtteranceQueue<T> {
  private cards: Card[] = [];
  private waiting: Job<T>[] = [];
  private running: { job: Job<T>; controller: AbortController } | null = null;
  private idleWaiters: (() => void)[] = [];
  private nextId = 1;

  constructor(
    private readonly handle: (job: Job<T>, context: JobContext) => Promise<Outcome>,
    private readonly onChange: (cards: Card[]) => void,
    /** Called for an utterance cancelled before it finished, to release what it held. */
    private readonly onCancelled: (job: Job<T>) => void = () => {},
    private readonly timing: Timing = TIMING,
  ) {}

  /** An id for an utterance still being spoken, so its card can be shown before it's queued. */
  reserveId(): number {
    return this.nextId++;
  }

  /** Queues an utterance, returning its card's id. */
  enqueue(text: string, detail: T, id = this.reserveId()): number {
    this.update((cards) => [
      ...cards,
      { id, transcript: text, status: { kind: "waiting" }, leaving: false },
    ]);
    this.waiting.push({ id, text, detail });
    void this.pump();
    return id;
  }

  /** Shows a notice that isn't about an utterance, replacing any with the same text. */
  notify(tone: "ok" | "info" | "warn" | "error", text: string): void {
    for (const card of this.cards) {
      if (card.transcript === null && "text" in card.status && card.status.text === text) {
        this.leave(card.id);
      }
    }
    const id = this.reserveId();
    const status: CardStatus =
      tone === "ok" || tone === "info"
        ? { kind: "done", text, tone }
        : { kind: "problem", text, tone };
    this.update((cards) => [...cards, { id, transcript: null, status, leaving: false }]);
    if (status.kind === "done") setTimeout(() => this.leave(id), this.timing.lingerMs);
  }

  /** Removes a card, cancelling its utterance if it hasn't finished. */
  dismiss(id: number): void {
    if (this.running?.job.id === id) {
      // The handler stops, and the card leaves once it has.
      this.running.controller.abort();
      return;
    }
    const queued = this.waiting.find((j) => j.id === id);
    if (queued) {
      this.waiting = this.waiting.filter((j) => j.id !== id);
      this.onCancelled(queued);
      this.resolveIfIdle();
    }
    this.leave(id);
  }

  /** Resolves once every queued utterance has been handled. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.running === null && this.waiting.length === 0;
  }

  private resolveIfIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private update(change: (cards: Card[]) => Card[]): void {
    this.cards = change(this.cards);
    this.onChange(this.cards);
  }

  private setStatus(id: number, status: CardStatus): void {
    this.update((cards) => cards.map((c) => (c.id === id ? { ...c, status } : c)));
  }

  private leave(id: number): void {
    if (!this.cards.some((c) => c.id === id && !c.leaving)) return;
    this.update((cards) => cards.map((c) => (c.id === id ? { ...c, leaving: true } : c)));
    setTimeout(() => this.update((cards) => cards.filter((c) => c.id !== id)), this.timing.leaveMs);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.waiting.shift();
    if (!job) {
      this.resolveIfIdle();
      return;
    }
    const controller = new AbortController();
    this.running = { job, controller };
    // Cancelling moves on straight away, rather than trusting the handler to stop promptly;
    // whatever it reports afterwards is ignored.
    const cancelled = new Promise<Outcome>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve({ kind: "cancelled" })),
    );
    const handled = this.handle(job, {
      signal: controller.signal,
      working: (label) => {
        if (!controller.signal.aborted) {
          this.setStatus(job.id, { kind: "working", label, since: performance.now() });
        }
      },
    }).catch((e: unknown): Outcome => ({ kind: "problem", tone: "error", text: message(e) }));
    let outcome = await Promise.race([handled, cancelled]);
    if (controller.signal.aborted) {
      outcome = { kind: "cancelled" };
      this.onCancelled(job);
    }
    this.running = null;
    if (outcome.kind === "cancelled") {
      this.leave(job.id);
    } else {
      this.setStatus(job.id, outcome);
      if (outcome.kind === "done") setTimeout(() => this.leave(job.id), this.timing.lingerMs);
    }
    void this.pump();
  }
}
