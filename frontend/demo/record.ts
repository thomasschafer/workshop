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
import { installSimulatedSpeech } from "../e2e/speech.ts";

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

/** Words spoken per second, roughly a brisk speaking pace. */
const WORDS_PER_SECOND = 3.5;

/**
 * How long, at most, the GIF shows the model working on an edit. Longer waits are sped up, so
 * the demo keeps moving; the edit itself is shown as it happened.
 */
const MAX_SHOWN_WAIT_SECONDS = 1;

/** When the model was working on an edit, in seconds since the epoch, as frames are timed. */
const waits: [number, number][] = [];

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
  await page.waitForTimeout((words / WORDS_PER_SECOND) * 1000 + 300);
  await page.mouse.up();
  const editing = page.locator(".card.working");
  await editing.waitFor();
  const started = Date.now() / 1000;
  await editing.waitFor({ state: "detached" });
  waits.push([started, Date.now() / 1000]);
  const result = (await page.locator(".card").last().textContent()) ?? "";
  if (!(await page.locator(".card.done").last().isVisible())) {
    throw new Error(`The edit for "${text}" didn't land: ${result}`);
  }
}

/** What the demo shows: opening a puzzle, three short edits by voice, and running the solution. */
async function perform(page: Page, token: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`);
  await page.waitForTimeout(1000);

  await tap(page, page.locator(".day", { hasText: new RegExp(`^${DAY}$`) }));
  await page.locator(".problem").getByText("Lantern Rows").waitFor();
  await page.waitForTimeout(2200);

  await tap(page, page.getByRole("button", { name: "Code", exact: true }));
  await page.waitForTimeout(600);
  await tap(page, page.locator(".cm-line", { hasText: "raise NotImplementedError" }).first());
  await page.waitForTimeout(400);
  // Lands at the top of the file, wherever the cursor is.
  await say(page, "import ints from AOC");
  await page.waitForTimeout(1200);
  await say(page, "replace this line with rows equals data dot split lines");
  await page.waitForTimeout(1200);
  await say(page, "new line return max of sum of ints of row for row in rows");
  await page.waitForTimeout(1800);

  await tap(page, page.getByRole("button", { name: "Run", exact: true }));
  await page.waitForTimeout(500);
  await tap(page, page.getByRole("button", { name: "Run sample" }));
  await page.locator(".run-result").getByText("✓").waitFor();
  await page.waitForTimeout(1300);
  await tap(page, page.getByRole("button", { name: "Run real input" }));
  await page.locator(".run-result").getByText("Real input").waitFor();
  await page.waitForTimeout(2500);
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

/** When a moment of the recording comes in the GIF, once long waits for the model are sped up. */
function shownAt(at: number): number {
  let removed = 0;
  for (const [start, end] of waits) {
    const length = end - start;
    if (length <= MAX_SHOWN_WAIT_SECONDS) continue;
    const elapsed = Math.min(Math.max(at - start, 0), length);
    removed += elapsed * (1 - MAX_SHOWN_WAIT_SECONDS / length);
  }
  return at - removed;
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
      const duration = next ? shownAt(next.at) - shownAt(frame.at) : 1;
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
    await context.addInitScript(installSimulatedSpeech, WORDS_PER_SECOND);
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
