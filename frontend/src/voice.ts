// Push-to-talk speech recognition using the browser's built-in engine.

interface RecognitionAlternative {
  transcript: string;
}

interface RecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: RecognitionAlternative;
}

interface RecognitionEvent extends Event {
  readonly results: { readonly length: number; [index: number]: RecognitionResult };
}

interface RecognitionErrorEvent extends Event {
  readonly error: string;
}

export interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  phrases?: unknown[];
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

export type RecognitionConstructor = new () => Recognition;
type PhraseConstructor = new (phrase: string, boost: number) => unknown;

function recognitionConstructor(): RecognitionConstructor | null {
  const w = window as unknown as Record<string, unknown>;
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as RecognitionConstructor) : null;
}

/** Recognition results joined into one transcript. */
export interface Joined {
  text: string;
  /**
   * Whether joining took guesswork, because pieces restated or overlapped each other, rather
   * than following on.
   */
  revised: boolean;
}

/**
 * Joins recognition results into one transcript. Most browsers give consecutive pieces of what
 * was said. Chrome on Android instead gives each result as its latest guess at everything said
 * so far, revisions included ("can you replace … with open", then "… with", then "… with open
 * (and …"). When every piece restates the same opening, the last piece is the transcript.
 */
export function joinSegments(segments: readonly string[]): Joined {
  const pieces = cleanSegments(segments);
  const [first, ...rest] = pieces;
  if (first === undefined) return { text: "", revised: false };
  const opening = openingWords(first);
  const restated = rest.length > 0 && rest.every((p) => openingWords(p).startsWith(opening));
  if (restated) return { text: pieces[pieces.length - 1] ?? "", revised: true };

  let text = "";
  let revised = false;
  for (const piece of pieces) {
    const lower = text.toLowerCase();
    const pieceLower = piece.toLowerCase();
    if (pieceLower.startsWith(lower)) {
      revised ||= lower !== "";
      text = piece;
    } else if (lower.endsWith(pieceLower)) {
      revised = true;
    } else {
      text = `${text} ${piece}`;
    }
  }
  return { text: text.trim(), revised };
}

function cleanSegments(segments: readonly string[]): string[] {
  return segments.map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s !== "");
}

/** The first two words, lower-cased, to recognise a piece that starts the sentence again. */
function openingWords(text: string): string {
  return text.toLowerCase().split(" ").slice(0, 2).join(" ");
}

export function speechSupported(): boolean {
  return recognitionConstructor() !== null;
}

export function speechUnavailableReason(): string {
  if (!window.isSecureContext) {
    return "Voice needs HTTPS. Open Workshop through `tailscale serve` (see the doctor checks) or on localhost.";
  }
  return "This browser has no built-in speech recognition. Try Safari on iOS or Chrome on Android.";
}

/** One recognition session: a held button can span several, as browsers end them after a pause. */
export interface SessionReport {
  /** The session's latest results, as the browser reported them. */
  results: string[];
  /** How many times the browser reported results. */
  events: number;
  errors: string[];
}

/** What was heard while the button was held. */
export interface Heard {
  /** Workshop's reading of what was said. */
  text: string;
  /**
   * The recogniser's pieces, in order, when it revised what it heard and joining them took
   * guesswork; otherwise empty.
   */
  pieces: string[];
  /** Why listening failed, if it did. */
  error: string | null;
  /** How listening went, for the log. */
  report: { heldMs: number; sessions: SessionReport[] };
}

/** Stops restarting if the browser keeps ending recognition straight away, such as offline. */
const MAX_RESTARTS = 30;

/**
 * Listens while the button is held. Browsers can end recognition by themselves after a pause
 * (Chrome on Android does, mid-sentence), so it restarts while the button is still held and the
 * pieces are joined.
 */
export class PushToTalk {
  private recognition: Recognition | null = null;
  private held = false;
  /** The sessions during this press, with what each heard. */
  private sessions: (SessionReport & { joined: Joined })[] = [];
  private startedAt = 0;
  private error: string | null = null;
  private restarts = 0;
  private ended: Promise<void> = Promise.resolve();
  private onInterim: (text: string) => void = () => {};
  private vocabulary: readonly string[] = [];

  constructor(private readonly ctor: RecognitionConstructor | null = recognitionConstructor()) {}

  /**
   * Starts listening. `vocabulary` biases recognition towards words such as identifiers in the
   * file, where the browser supports it.
   */
  start(onInterim: (text: string) => void, vocabulary: readonly string[] = []): void {
    if (!this.ctor) {
      throw new Error(speechUnavailableReason());
    }
    this.cancel();
    this.held = true;
    this.sessions = [];
    this.startedAt = performance.now();
    this.error = null;
    this.restarts = 0;
    this.onInterim = onInterim;
    this.vocabulary = vocabulary;
    this.startSession(this.ctor);
  }

  /** Stops listening and resolves with everything heard. */
  async stop(): Promise<Heard> {
    this.held = false;
    const recognition = this.recognition;
    if (recognition) {
      recognition.stop();
      await this.ended;
    }
    this.recognition = null;
    const revised = this.sessions.some((s) => s.joined.revised);
    const pieces = revised ? this.sessions.flatMap((s) => cleanSegments(s.results)) : [];
    return {
      text: this.transcript(),
      pieces: pieces.filter((piece, i) => piece !== pieces[i - 1]),
      error: this.error,
      report: {
        heldMs: Math.round(performance.now() - this.startedAt),
        sessions: this.sessions.map(({ results, events, errors }) => ({ results, events, errors })),
      },
    };
  }

  cancel(): void {
    this.held = false;
    this.recognition?.abort();
    this.recognition = null;
  }

  private transcript(): string {
    return this.sessions
      .map((s) => s.joined.text)
      .filter((t) => t !== "")
      .join(" ");
  }

  private startSession(Ctor: RecognitionConstructor): void {
    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-GB";
    recognition.continuous = true;
    recognition.interimResults = true;
    const Phrase = (globalThis as unknown as Record<string, unknown>).SpeechRecognitionPhrase;
    if (typeof Phrase === "function" && "phrases" in recognition && this.vocabulary.length > 0) {
      try {
        recognition.phrases = this.vocabulary
          .slice(0, 100)
          .map((word) => new (Phrase as PhraseConstructor)(word, 5));
      } catch {
        // Biasing is an optional improvement; recognition works without it.
      }
    }
    const session = {
      results: [] as string[],
      events: 0,
      errors: [] as string[],
      joined: { text: "", revised: false },
    };
    this.sessions.push(session);
    recognition.onresult = (event) => {
      const segments: string[] = [];
      for (let i = 0; i < event.results.length; i++) {
        segments.push(event.results[i]?.[0]?.transcript ?? "");
      }
      session.results = segments;
      session.events++;
      session.joined = joinSegments(segments);
      this.onInterim(this.transcript());
    };
    this.ended = new Promise((resolve) => {
      let failed = false;
      recognition.onerror = (event) => {
        session.errors.push(event.error);
        if (event.error === "no-speech" || event.error === "aborted") return;
        failed = true;
        this.error =
          event.error === "not-allowed" || event.error === "service-not-allowed"
            ? "Microphone access was refused. Allow it in your browser's site settings."
            : `Speech recognition failed: ${event.error}`;
      };
      recognition.onend = () => {
        if (this.recognition !== recognition) {
          resolve();
          return;
        }
        if (this.held && !failed && this.restarts < MAX_RESTARTS) {
          // Ended by the browser while the button is still held: keep listening.
          this.restarts++;
          this.startSession(Ctor);
          // Whoever is waiting for the end now waits for the new session instead.
          void this.ended.then(resolve);
          return;
        }
        resolve();
      };
    });
    this.recognition = recognition;
    recognition.start();
  }
}
