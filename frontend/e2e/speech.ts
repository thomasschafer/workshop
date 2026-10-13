// Simulated speech recognition, for tests and the demo: what's "said" is set on the page, and
// appears word by word as if spoken.

/** Stands in for the browser's speech recognition, and shows taps, which videos don't. */
export function installSimulatedSpeech(wordsPerSecond: number): void {
  const speech = { text: "" };
  (window as unknown as { demoSpeech: typeof speech }).demoSpeech = speech;

  class FakeRecognition {
    lang = "";
    continuous = false;
    interimResults = false;
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    private timer: ReturnType<typeof setInterval> | undefined;
    private heard = "";

    start(): void {
      const words = speech.text.split(" ");
      let count = 0;
      this.timer = setInterval(() => {
        count++;
        this.emit(words.slice(0, count).join(" "), false);
        if (count >= words.length) clearInterval(this.timer);
      }, 1000 / wordsPerSecond);
    }

    stop(): void {
      clearInterval(this.timer);
      this.emit(this.heard, true);
      setTimeout(() => this.onend?.(), 50);
    }

    abort(): void {
      clearInterval(this.timer);
      this.onend?.();
    }

    private emit(transcript: string, isFinal: boolean): void {
      this.heard = transcript;
      const result = Object.assign([{ transcript }], { isFinal });
      this.onresult?.({ results: { length: 1, 0: result } });
    }
  }
  Object.assign(window, { SpeechRecognition: FakeRecognition, webkitSpeechRecognition: undefined });

  window.addEventListener("pointerdown", (event) => {
    const dot = document.createElement("div");
    Object.assign(dot.style, {
      position: "fixed",
      left: `${event.clientX - 22}px`,
      top: `${event.clientY - 22}px`,
      width: "44px",
      height: "44px",
      borderRadius: "50%",
      background: "rgba(255, 255, 255, 0.35)",
      border: "2px solid rgba(255, 255, 255, 0.7)",
      pointerEvents: "none",
      zIndex: "9999",
      transition: "opacity 300ms",
    });
    document.body.append(dot);
    const shown = Date.now();
    const hide = () => {
      window.removeEventListener("pointerup", hide);
      setTimeout(
        () => {
          dot.style.opacity = "0";
          setTimeout(() => dot.remove(), 300);
        },
        Math.max(0, 250 - (Date.now() - shown)),
      );
    };
    window.addEventListener("pointerup", hide);
  });
}
