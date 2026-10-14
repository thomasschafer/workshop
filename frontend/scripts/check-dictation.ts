// Checks dictation with Whisper end to end, with real recording: Chrome's microphone plays a
// recording of speech, the talk button is held while it plays, and Whisper on this machine
// hears it. Needs whisper-cli and the small.en model downloaded, and macOS's `say` and ffmpeg
// to make the recording, so it isn't part of CI.
//
// Run with `mise run check-dictation`, after building the server and frontend.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, devices, type Page } from "@playwright/test";
import { writeHome } from "../e2e/fixture.ts";

const PORT = 7897;
const ROOT = resolve(import.meta.dirname, "..", "..");
const HOME = join(tmpdir(), "workshop-check-dictation");
const PHRASE = "new line return max of sum of ints of row for row in rows";
/** Where Workshop keeps Whisper's models on macOS, so this uses the ones already downloaded. */
const MODELS = join(homedir(), "Library", "Caches", "workshop", "whisper");

const PUZZLE = `<html><body><main><article class="day-desc"><h2>--- Day 4: Rows ---</h2>
<p>For example:</p><pre><code>1 2
</code></pre></article></main></body></html>`;

/** Holds the talk button for `ms`, noting the button's state as it changes. */
async function hold(page: Page, ms: number): Promise<string[]> {
  const button = page.locator(".talk");
  const box = await button.boundingBox();
  if (!box) throw new Error("The talk button isn't visible.");
  const states: string[] = [];
  const note = async () => {
    const state = `${(await button.getAttribute("class")) ?? ""} | ${await button.textContent()}`;
    if (states.at(-1) !== state) states.push(state);
  };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await note();
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await note();
  return states;
}

async function main(): Promise<void> {
  const recording = join(tmpdir(), "workshop-check-dictation.wav");
  const spoken = join(tmpdir(), "workshop-check-dictation.aiff");
  execFileSync("say", ["-o", spoken, PHRASE]);
  // A second of quiet first, as the microphone takes a moment to start.
  execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-t",
    "1",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-i",
    spoken,
    "-filter_complex",
    "[1]aresample=48000[s];[0][s]concat=n=2:v=0:a=1",
    recording,
  ]);

  writeHome({
    home: HOME,
    port: PORT,
    year: 2017,
    day: 4,
    puzzle: PUZZLE,
    input: "1 2\n",
    stars: {},
    model: "fake",
  });
  mkdirSync(join(HOME, "cache"), { recursive: true });
  symlinkSync(MODELS, join(HOME, "cache", "whisper"));

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
  // Before the server starts, so a browser that won't launch doesn't leave it running.
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${recording}`,
    ],
  });
  const server = spawn(join(ROOT, "target", "debug", "workshop"), ["serve"], {
    env: { ...process.env, WORKSHOP_HOME: HOME, RUST_LOG: "workshop=info" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const token = readFileSync(join(HOME, "config", "token"), "utf8").trim();
    const context = await browser.newContext({ ...devices["Pixel 7"] });
    await context.grantPermissions(["microphone"]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`);
    await page.getByRole("button", { name: "2017" }).click();
    await page.locator(".day", { hasText: /^4$/ }).click();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.locator(".cm-line").first().waitFor();

    for (const attempt of [1, 2]) {
      const states = await hold(page, 5000);
      console.log(`press ${attempt}:\n  ${states.join("\n  ")}`);
      const card = page.locator(".card", { hasText: "“" }).last();
      await card.waitFor({ timeout: 20_000 });
      console.log(`  heard: ${await card.locator(".card-transcript").textContent()}`);
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

await main();
