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

/**
 * Joins recognition results into one transcript. Most browsers give consecutive pieces of what
 * was said. Chrome on Android instead gives each result as its latest guess at everything said
 * so far, revisions included ("can you replace … with open", then "… with", then "… with open
 * (and …"). When every piece restates the same opening, the last piece is the transcript.
 */
export function mergeSegments(segments: readonly string[]): string {
  const pieces = segments.map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s !== "");
  const [first, ...rest] = pieces;
  if (first === undefined) return "";
  const opening = openingWords(first);
  const restated = rest.length > 0 && rest.every((p) => openingWords(p).startsWith(opening));
  if (restated) return pieces[pieces.length - 1] ?? "";

  let text = "";
  for (const piece of pieces) {
    const lower = text.toLowerCase();
    const pieceLower = piece.toLowerCase();
    if (pieceLower.startsWith(lower)) {
      text = piece;
    } else if (!lower.endsWith(pieceLower)) {
      text = `${text} ${piece}`;
    }
  }
  return text.trim();
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
  /** Transcripts of earlier sessions during this press. */
  private finished: string[] = [];
  private current = "";
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
    this.finished = [];
    this.current = "";
    this.error = null;
    this.restarts = 0;
    this.onInterim = onInterim;
    this.vocabulary = vocabulary;
    this.startSession(this.ctor);
  }

  /** Stops listening and resolves with everything heard. */
  async stop(): Promise<string> {
    this.held = false;
    const recognition = this.recognition;
    if (recognition) {
      recognition.stop();
      await this.ended;
    }
    this.recognition = null;
    if (this.error) {
      throw new Error(this.error);
    }
    return this.transcript();
  }

  cancel(): void {
    this.held = false;
    this.recognition?.abort();
    this.recognition = null;
  }

  private transcript(): string {
    return [...this.finished, this.current].filter((t) => t !== "").join(" ");
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
    recognition.onresult = (event) => {
      const segments: string[] = [];
      for (let i = 0; i < event.results.length; i++) {
        segments.push(event.results[i]?.[0]?.transcript ?? "");
      }
      this.current = mergeSegments(segments);
      this.onInterim(this.transcript());
    };
    this.ended = new Promise((resolve) => {
      let failed = false;
      recognition.onerror = (event) => {
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
          if (this.current !== "") this.finished.push(this.current);
          this.current = "";
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
