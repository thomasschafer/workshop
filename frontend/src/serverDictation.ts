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
  ) {
    this.startedAt = performance.now();
    this.recording = AudioRecorder.start(onListening);
    // Reported by `stop`, which every press ends with.
    this.recording.catch(() => {});
  }

  async stop(): Promise<Heard> {
    const report = { heldMs: Math.round(performance.now() - this.startedAt), sessions: [] };
    const heard = (text: string, error: string | null = null): Heard => ({
      text,
      pieces: [],
      error,
      report,
    });
    const recording = this.recording;
    this.recording = null;
    if (!recording) return heard("");
    let audio: AudioRecorder;
    try {
      audio = await recording;
    } catch (e) {
      return heard("", microphoneError(e));
    }
    try {
      const { wav, peak } = await audio.stop();
      if (peak < SILENT_PEAK) return heard("");
      const { text } = await api.transcribe(wav);
      return heard(text);
    } catch (e) {
      return heard("", `Couldn't hear that: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  cancel(): void {
    const recording = this.recording;
    this.recording = null;
    recording?.then((audio) => audio.cancel()).catch(() => {});
  }
}

function microphoneError(e: unknown): string {
  if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
    return "Microphone access was refused. Allow it in your browser's site settings.";
  }
  return `Couldn't use the microphone: ${e instanceof Error ? e.message : String(e)}`;
}
