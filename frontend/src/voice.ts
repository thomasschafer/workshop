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
 * was said, but Chrome on Android gives each result as a growing copy of everything so far
 * ("can", "can you", "can you replace"), so a piece that extends the text so far replaces it
 * rather than being appended.
 */
export function mergeSegments(segments: readonly string[]): string {
  let text = "";
  for (const raw of segments) {
    const segment = raw.trim().replace(/\s+/g, " ");
    if (!segment) continue;
    const lower = text.toLowerCase();
    const segmentLower = segment.toLowerCase();
    if (segmentLower.startsWith(lower)) {
      text = segment;
    } else if (!lower.endsWith(segmentLower)) {
      text = `${text} ${segment}`;
    }
  }
  return text.trim();
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
