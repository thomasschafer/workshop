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

interface Recognition extends EventTarget {
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

type RecognitionConstructor = new () => Recognition;
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

export class PushToTalk {
  private recognition: Recognition | null = null;
  private transcript = "";
  private error: string | null = null;
  private ended: Promise<void> = Promise.resolve();

  /**
   * Starts listening. `vocabulary` biases recognition towards words such as identifiers in the
   * file, where the browser supports it.
   */
  start(onInterim: (text: string) => void, vocabulary: readonly string[] = []): void {
    const Ctor = recognitionConstructor();
    if (!Ctor) {
      throw new Error(speechUnavailableReason());
    }
    this.cancel();
    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-GB";
    recognition.continuous = true;
    recognition.interimResults = true;
    const Phrase = (window as unknown as Record<string, unknown>).SpeechRecognitionPhrase;
    if (typeof Phrase === "function" && "phrases" in recognition && vocabulary.length > 0) {
      try {
        recognition.phrases = vocabulary
          .slice(0, 100)
          .map((word) => new (Phrase as PhraseConstructor)(word, 5));
      } catch {
        // Biasing is an optional improvement; recognition works without it.
      }
    }
    this.transcript = "";
    this.error = null;
    recognition.onresult = (event) => {
      const segments: string[] = [];
      for (let i = 0; i < event.results.length; i++) {
        segments.push(event.results[i]?.[0]?.transcript ?? "");
      }
      this.transcript = mergeSegments(segments);
      onInterim(this.transcript);
    };
    this.ended = new Promise((resolve) => {
      recognition.onend = () => resolve();
      recognition.onerror = (event) => {
        if (event.error !== "no-speech" && event.error !== "aborted") {
          this.error =
            event.error === "not-allowed" || event.error === "service-not-allowed"
              ? "Microphone access was refused. Allow it in your browser's site settings."
              : `Speech recognition failed: ${event.error}`;
        }
        resolve();
      };
    });
    this.recognition = recognition;
    recognition.start();
  }

  /** Stops listening and resolves with everything heard. */
  async stop(): Promise<string> {
    const recognition = this.recognition;
    if (!recognition) {
      return "";
    }
    recognition.stop();
    await this.ended;
    this.recognition = null;
    if (this.error) {
      throw new Error(this.error);
    }
    return this.transcript;
  }

  cancel(): void {
    this.recognition?.abort();
    this.recognition = null;
  }
}
