import { api } from "./api";
import { AudioRecorder } from "./audio";
import type { Heard, Listener } from "./voice";

/**
 * Below this, a recording is taken to be silence. Whisper tends to invent words, such as "Thank
 * you.", for silence, so it isn't sent at all.
 */
const SILENT_PEAK = 0.02;

/** Records while the button is held, then has Whisper on the server hear it. */
export class ServerDictation implements Listener {
  private recording: Promise<AudioRecorder> | null = null;
  private startedAt = 0;

  start(
    _onInterim: (text: string) => void,
    _vocabulary: readonly string[],
    onListening: () => void,
    onLevel: (level: number) => void,
  ) {
    this.startedAt = performance.now();
    this.recording = AudioRecorder.start(onListening, onLevel);
    // Reported by `stop`, which every press ends with.
    this.recording.catch(() => {});
  }

  async stop(): Promise<Heard> {
    const heldMs = Math.round(performance.now() - this.startedAt);
    const heard = (text: string, error: string | null, report: Heard["report"]): Heard => ({
      text,
      pieces: [],
      error,
      report,
    });
    const recording = this.recording;
    this.recording = null;
    if (!recording) return heard("", null, { heldMs, sessions: [] });
    let audio: AudioRecorder;
    try {
      audio = await recording;
    } catch (e) {
      return heard("", microphoneError(e), { heldMs, sessions: [] });
    }
    const { wav, peak, report } = await audio.stop();
    const log = { heldMs, sessions: [], recording: report };
    if (report.startMs === null && heldMs >= QUICK_PRESS_MS) {
      return heard(
        "",
        "The microphone sent no sound. Another app may be using it; if so, close that and try again.",
        log,
      );
    }
    if (peak < SILENT_PEAK) return heard("", null, log);
    try {
      const { text } = await api.transcribe(wav);
      return heard(text, null, log);
    } catch (e) {
      return heard("", `Couldn't hear that: ${e instanceof Error ? e.message : String(e)}`, log);
    }
  }

  cancel(): void {
    const recording = this.recording;
    this.recording = null;
    recording?.then((audio) => audio.cancel()).catch(() => {});
  }
}

/** Shorter than this, a microphone may not have started at all, which is no fault of its own. */
const QUICK_PRESS_MS = 1000;

function microphoneError(e: unknown): string {
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
    return `Couldn't use the microphone (${detail}). If Workshop isn't allowed to, allow it in your browser's site settings.`;
  }
  return `Couldn't use the microphone (${detail}).`;
}
