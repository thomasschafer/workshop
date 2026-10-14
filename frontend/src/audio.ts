/** The sample rate Whisper works at. */
export const WHISPER_RATE = 16_000;

/** Whether this browser can record from the microphone. */
export function recordingSupported(): boolean {
  return (
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder === "function"
  );
}

/** A recording, ready for Whisper. */
export interface Recording {
  wav: ArrayBuffer;
  /** The loudest sample, from 0 to 1, to tell silence from speech. */
  peak: number;
}

/**
 * Records from the microphone until stopped, as 16 kHz mono WAV, which Whisper takes. Converting
 * here means the server needs nothing else to read it, on any platform.
 */
export class AudioRecorder {
  private readonly chunks: Blob[] = [];

  private constructor(
    private readonly stream: MediaStream,
    private readonly recorder: MediaRecorder,
  ) {
    recorder.ondataavailable = (event) => this.chunks.push(event.data);
  }

  /** Starts recording; `onStarted` is called once audio is being captured. */
  static async start(onStarted: () => void = () => {}): Promise<AudioRecorder> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const audio = new AudioRecorder(stream, recorder);
    recorder.onstart = () => onStarted();
    recorder.start();
    return audio;
  }

  /** Stops recording and lets the microphone go, keeping nothing. */
  cancel(): void {
    if (this.recorder.state !== "inactive") this.recorder.stop();
    for (const track of this.stream.getTracks()) track.stop();
  }

  async stop(): Promise<Recording> {
    const stopped = new Promise<void>((resolve) => {
      this.recorder.onstop = () => resolve();
    });
    this.recorder.stop();
    await stopped;
    for (const track of this.stream.getTracks()) track.stop();
    const encoded = await new Blob(this.chunks, { type: this.recorder.mimeType }).arrayBuffer();
    const decoded = await new AudioContext().decodeAudioData(encoded);
    const length = Math.max(1, Math.ceil(decoded.duration * WHISPER_RATE));
    const offline = new OfflineAudioContext(1, length, WHISPER_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const samples = (await offline.startRendering()).getChannelData(0);
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    return { wav: encodeWav(samples, WHISPER_RATE), peak };
  }
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
