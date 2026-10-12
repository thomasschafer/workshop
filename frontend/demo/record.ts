// Records the README demo: Workshop on an emulated phone, solving an invented puzzle by voice.
// Speech recognition is simulated, so each utterance appears word by word as if spoken, but
// the edits come from your configured edit model, so this makes real model calls.
//
// Run with `mise run demo`, after building the server and frontend.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, devices, type Page } from "@playwright/test";
import { writeHome } from "../e2e/fixture.ts";

const PORT = 7898;
const HOME = join(tmpdir(), "workshop-demo");
const ROOT = resolve(import.meta.dirname, "..", "..");
const FRAMES_DIR = join(HOME, "frames");
const OUTPUT = join(ROOT, "docs", "demo.gif");
const YEAR = 2025;
const DAY = 9;

// Invented for the demo. Never put a real puzzle or input here.
const PUZZLE = `<html><body><main>
<article class="day-desc"><h2>--- Day ${DAY}: Lantern Rows ---</h2>
<p>Each line lists the lanterns on one row of the market stalls. Which row has the most?</p>
<p>For example:</p>
<pre><code>3 4
10
1 2 3
</code></pre>
<p>The rows have 7, 10 and 6 lanterns, so the answer is <code><em>10</em></code>.</p>
</article>
</main></body></html>`;
const INPUT = "5 8 13\n21 1\n2 2 2 2\n40\n9 9 9\n";

/** Words spoken per second, roughly a relaxed speaking pace. */
const WORDS_PER_SECOND = 3;

/** Stands in for the browser's speech recognition, and shows taps, which videos don't. */
function installDemoHelpers(wordsPerSecond: number): void {
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

async function tap(page: Page, selector: ReturnType<Page["locator"]>): Promise<void> {
  const box = await selector.boundingBox();
  if (!box) throw new Error(`Nothing to tap: ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
}

/** Holds the talk button while "saying" `text`, then waits for the edit. */
async function say(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    (window as unknown as { demoSpeech: { text: string } }).demoSpeech.text = t;
  }, text);
  const button = page.locator(".talk");
  const box = await button.boundingBox();
  if (!box) throw new Error("The talk button isn't visible.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const words = text.split(" ").length;
  await page.waitForTimeout((words / WORDS_PER_SECOND) * 1000 + 600);
  await page.mouse.up();
  const editing = page.locator(".talk.working");
  await editing.waitFor();
  await editing.waitFor({ state: "detached" });
  const feedback = (await page.locator(".feedback").textContent()) ?? "";
  if (/couldn't|failed|error/i.test(feedback)) {
    throw new Error(`The edit for "${text}" failed: ${feedback}`);
  }
}

/** What the demo shows: opening a puzzle, two edits by voice, and running the solution. */
async function perform(page: Page, token: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`);
  await page.waitForTimeout(1200);

  await tap(page, page.locator(".day", { hasText: new RegExp(`^${DAY}$`) }));
  await page.locator(".problem").getByText("Lantern Rows").waitFor();
  await page.waitForTimeout(2500);

  await tap(page, page.getByRole("button", { name: "Code", exact: true }));
  await page.waitForTimeout(800);
  await tap(page, page.locator(".cm-line", { hasText: "raise NotImplementedError" }).first());
  await page.waitForTimeout(600);
  await say(page, "replace this line with rows equals data dot split lines");
  await page.waitForTimeout(2000);
  await say(page, "new line return max of sum of map int of row dot split for row in rows");
  await page.waitForTimeout(2500);

  await tap(page, page.getByRole("button", { name: "Run", exact: true }));
  await page.waitForTimeout(700);
  await tap(page, page.getByRole("button", { name: "Run sample" }));
  await page.locator(".run-result").getByText("✓").waitFor();
  await page.waitForTimeout(1500);
  await tap(page, page.getByRole("button", { name: "Run real input" }));
  await page.locator(".run-result").getByText("Real input").waitFor();
  await page.waitForTimeout(3000);
}

async function waitForServer(server: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`The server exited with ${server.exitCode}.`);
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/bootstrap`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("The server didn't start.");
}

/** Captures the page as frames with timestamps, through Chrome's screencast. */
async function startCapture(page: Page): Promise<() => Promise<string>> {
  mkdirSync(FRAMES_DIR, { recursive: true });
  const frames: { file: string; at: number }[] = [];
  const session = await page.context().newCDPSession(page);
  session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = join(FRAMES_DIR, `${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000 });
    void session.send("Page.screencastFrameAck", { sessionId });
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 90, everyNthFrame: 1 });
  return async () => {
    await session.send("Page.stopScreencast");
    if (frames.length < 2) throw new Error("The screencast captured no frames.");
    // Frames only arrive when something changes, so each is shown until the next one.
    const list = frames.flatMap((frame, i) => {
      const next = frames[i + 1];
      const duration = next ? next.at - frame.at : 1;
      return [`file '${frame.file}'`, `duration ${duration.toFixed(3)}`];
    });
    const last = frames.at(-1);
    if (last) list.push(`file '${last.file}'`);
    const listFile = join(FRAMES_DIR, "frames.txt");
    writeFileSync(listFile, `${list.join("\n")}\n`);
    return listFile;
  };
}

async function record(): Promise<string> {
  writeHome({
    home: HOME,
    port: PORT,
    year: YEAR,
    day: DAY,
    puzzle: PUZZLE,
    input: INPUT,
    stars: { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 1, 8: 2, 9: 0 },
    model: "default",
  });
  const server = spawn(join(ROOT, "target", "debug", "workshop"), ["serve"], {
    env: { ...process.env, WORKSHOP_HOME: HOME, RUST_LOG: process.env.RUST_LOG ?? "workshop=warn" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    await waitForServer(server);
    const token = readFileSync(join(HOME, "config", "token"), "utf8").trim();
    const device = devices["Pixel 7"];
    const context = await browser.newContext({
      ...device,
      colorScheme: "dark",
    });
    await context.addInitScript(installDemoHelpers, WORDS_PER_SECOND);
    // A phone screen is too narrow for the demo's longest line.
    await context.addInitScript(() => localStorage.setItem("workshop:line-wrapping", "true"));
    const page = await context.newPage();
    const stopCapture = await startCapture(page);
    try {
      await perform(page, token);
    } catch (err) {
      const screenshot = join(HOME, "failure.png");
      await page.screenshot({ path: screenshot });
      throw new Error(`The demo failed; the page at that point is in ${screenshot}.`, {
        cause: err,
      });
    }
    const frames = await stopCapture();
    await context.close();
    return frames;
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

const frames = await record();
mkdirSync(join(ROOT, "docs"), { recursive: true });
// Two passes: a palette from the whole video, then the GIF with it, which keeps colours true.
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    frames,
    "-vf",
    "fps=12,scale=360:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
    OUTPUT,
  ],
  { stdio: "inherit" },
);
rmSync(FRAMES_DIR, { recursive: true, force: true });
console.log(`Saved ${OUTPUT}`);
