import { api, ConnectionError, connection } from "./api";
import { AudioRecorder } from "./audio";
import type { Heard, Listener, Listening } from "./voice";

/**
 * Below this, a recording is taken to be silence. Whisper tends to invent words, such as "Thank
 * you.", for silence, so it isn't sent at all.
 */
const SILENT_PEAK = 0.02;

/** Records while the button is held, then has Whisper on the server hear it. */
export class ServerDictation implements Listener {
  private recording: Promise<AudioRecorder> | null = null;
  private startedAt = 0;

  private onDelay: (reason: string | null) => void = () => {};

  start({ onListening, onLevel, onDelay = () => {} }: Listening) {
    this.startedAt = performance.now();
    this.onDelay = onDelay;
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
      return heard(await this.transcribe(wav), null, log);
    } catch (e) {
      return heard("", `Couldn't hear that: ${e instanceof Error ? e.message : String(e)}`, log);
    }
  }

  /**
   * Has Whisper hear a recording, waiting for the server if it can't be reached, such as while
   * it wakes up, so what was said isn't lost.
   */
  private async transcribe(wav: ArrayBuffer): Promise<string> {
    const giveUp = AbortSignal.timeout(SERVER_WAIT_MS);
    for (;;) {
      try {
        return (await api.transcribe(wav)).text;
      } catch (e) {
        if (!(e instanceof ConnectionError)) throw e;
        this.onDelay("Waiting for the server…");
        try {
          await connection.whenOnline(giveUp);
        } catch {
          throw new Error("the server couldn't be reached");
        } finally {
          this.onDelay(null);
        }
      }
    }
  }

  cancel(): void {
    const recording = this.recording;
    this.recording = null;
    recording?.then((audio) => audio.cancel()).catch(() => {});
  }
}

/** How long to wait for the server to be reachable before giving up on a recording. */
const SERVER_WAIT_MS = 120_000;

/** Shorter than this, a microphone may not have started at all, which is no fault of its own. */
const QUICK_PRESS_MS = 1000;

function microphoneError(e: unknown): string {
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
    return `Couldn't use the microphone (${detail}). If Workshop isn't allowed to, allow it in your browser's site settings.`;
  }
  return `Couldn't use the microphone (${detail}).`;
}
