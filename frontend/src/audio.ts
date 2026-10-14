/** The sample rate Whisper works at. */
export const WHISPER_RATE = 16_000;

/** Whether this browser can record from the microphone. */
export function recordingSupported(): boolean {
  return (
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof AudioWorkletNode === "function"
  );
}

/** A recording, ready for Whisper. */
export interface Recording {
  wav: ArrayBuffer;
  /** The loudest sample, from 0 to 1, to tell silence from speech. */
  peak: number;
  /** How the recording went, for the log. */
  report: RecordingReport;
}

export interface RecordingReport {
  /** From asking for the microphone to its first sound; null if it sent none. */
  startMs: number | null;
  /** The length of the recording. */
  seconds: number;
  peak: number;
  sampleRate: number;
  /** Whether the browser said the microphone was muted, such as by another app using it. */
  muted: boolean;
  /** What the browser says about the microphone, such as its echo cancellation. */
  settings: MediaTrackSettings | null;
}

/** Collects the microphone's sound in batches, off the main thread. */
const PROCESSOR = `
class WorkshopRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = [];
    this.size = 0;
    this.port.onmessage = () => this.flush(true);
  }
  flush(last) {
    const out = new Float32Array(this.size);
    let at = 0;
    for (const part of this.batch) {
      out.set(part, at);
      at += part.length;
    }
    this.batch = [];
    this.size = 0;
    this.port.postMessage({ samples: out, last }, [out.buffer]);
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      this.batch.push(channel.slice(0));
      this.size += channel.length;
      if (this.size >= 2048) this.flush(false);
    }
    return true;
  }
}
registerProcessor("workshop-recorder", WorkshopRecorder);
`;

/**
 * One audio context for every recording: phones are slow to create them, and limit how many a
 * page can have.
 */
let shared: { context: AudioContext; ready: Promise<void> } | null = null;

/**
 * Recordings starting or under way. The context is paused a while after there are none, as a
 * running one keeps the phone's audio hardware busy. Not straight away: pausing and resuming
 * at once can leave it paused in some browsers, and presses often come in quick succession.
 */
let recordings = 0;
let pausing: ReturnType<typeof setTimeout> | undefined;
const PAUSE_AFTER_MS = 10_000;

function audioContext(): { context: AudioContext; ready: Promise<void> } {
  if (shared === null || shared.context.state === "closed") {
    const context = new AudioContext();
    const url = URL.createObjectURL(new Blob([PROCESSOR], { type: "text/javascript" }));
    shared = { context, ready: context.audioWorklet.addModule(url) };
  }
  return shared;
}

/**
 * Records from the microphone until stopped, as 16 kHz mono WAV, which Whisper takes. The sound
 * is collected as it is, rather than encoded and decoded again, so stopping is quick and even a
 * very short recording can be read.
 */
export class AudioRecorder {
  private readonly chunks: Float32Array[] = [];
  private firstSoundMs: number | null = null;
  private stopped: (() => void) | null = null;

  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly node: AudioWorkletNode,
    private readonly startedAt: number,
    onStarted: () => void,
    onLevel: (level: number) => void,
  ) {
    node.port.onmessage = (event: MessageEvent<{ samples: Float32Array; last: boolean }>) => {
      const { samples, last } = event.data;
      if (samples.length > 0) {
        this.chunks.push(samples);
        const peak = peakOf(samples);
        // A microphone that isn't working yet sends exact silence; a working one never does.
        if (this.firstSoundMs === null && peak > 0) {
          this.firstSoundMs = performance.now() - this.startedAt;
          onStarted();
        }
        onLevel(peak);
      }
      if (last) this.stopped?.();
    };
  }

  /**
   * Starts recording. `onStarted` is called once sound is arriving, which can take a moment
   * after the microphone is granted; `onLevel` with how loud each moment is, from 0 to 1.
   */
  static async start(
    onStarted: () => void = () => {},
    onLevel: (level: number) => void = () => {},
  ): Promise<AudioRecorder> {
    const startedAt = performance.now();
    // Before anything is awaited, while this is still part of the press: browsers only let
    // audio start in response to one.
    const { context, ready } = audioContext();
    recordings++;
    clearTimeout(pausing);
    const resumed = context.resume();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      finished(context);
      throw e;
    }
    try {
      await Promise.all([ready, resumed]);
      if (context.state !== "running") await context.resume();
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "workshop-recorder");
      const audio = new AudioRecorder(stream, context, source, node, startedAt, onStarted, onLevel);
      source.connect(node);
      // Browsers only keep a node working while it leads somewhere. It outputs nothing.
      node.connect(context.destination);
      return audio;
    } catch (e) {
      for (const track of stream.getTracks()) track.stop();
      finished(context);
      throw e;
    }
  }

  /** Stops recording and lets the microphone go, keeping nothing. */
  cancel(): void {
    this.release();
  }

  async stop(): Promise<Recording> {
    // The last batch, so nothing said just before letting go is lost.
    const flushed = new Promise<void>((resolve) => {
      this.stopped = resolve;
    });
    this.node.port.postMessage("flush");
    await Promise.race([flushed, new Promise((r) => setTimeout(r, 200))]);
    const track = this.stream.getAudioTracks()[0];
    const muted = track?.muted ?? false;
    const settings = track?.getSettings() ?? null;
    this.release();
    const samples = resample(concat(this.chunks), this.context.sampleRate, WHISPER_RATE);
    const peak = peakOf(samples);
    return {
      wav: encodeWav(samples, WHISPER_RATE),
      peak,
      report: {
        startMs: this.firstSoundMs === null ? null : Math.round(this.firstSoundMs),
        seconds: Math.round((samples.length / WHISPER_RATE) * 100) / 100,
        peak: Math.round(peak * 1000) / 1000,
        sampleRate: this.context.sampleRate,
        muted,
        settings,
      },
    };
  }

  private released = false;

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.source.disconnect();
    this.node.disconnect();
    this.node.port.onmessage = null;
    for (const track of this.stream.getTracks()) track.stop();
    finished(this.context);
  }
}

/** Notes a recording has finished, pausing the context a while later if it was the last. */
function finished(context: AudioContext): void {
  recordings--;
  if (recordings > 0) return;
  clearTimeout(pausing);
  pausing = setTimeout(() => {
    if (recordings === 0 && context.state === "running") {
      // A failure to pause only costs battery, and the next recording resumes it anyway.
      context.suspend().catch(() => {});
    }
  }, PAUSE_AFTER_MS);
}

function concat(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The loudest sample, from 0 to 1. */
export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

/**
 * Changes a recording's sample rate, averaging the samples each new one stands for when there
 * are fewer, which keeps sounds too high for the new rate from turning into noise.
 */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = i * ratio;
    if (ratio > 1) {
      const end = Math.min(samples.length, Math.floor(start + ratio));
      let sum = 0;
      for (let j = Math.floor(start); j < end; j++) sum += samples[j] ?? 0;
      out[i] = sum / Math.max(1, end - Math.floor(start));
    } else {
      const j = Math.floor(start);
      const fraction = start - j;
      out[i] = (samples[j] ?? 0) * (1 - fraction) + (samples[j + 1] ?? samples[j] ?? 0) * fraction;
    }
  }
  return out;
}

/** Mono 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return buffer;
}
