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
interface Case {
  /** What macOS's `say` speaks, with `[[slnc 1200]]` for a pause. */
  speech: string;
  presses: number;
  holdMs: number;
  /** Words that must be heard, each press: ones Whisper hears reliably in macOS's voice. */
  heard: string[];
}

const CASES: Case[] = [
  // Pressed twice, as the second press reuses what the first started.
  {
    speech: "new line return max of sum of ints of row for row in rows",
    presses: 2,
    holdMs: 5000,
    heard: ["new line", "return max"],
  },
];

/**
 * Recordings sent straight to the server, as the app sends what it records, for speech too long
 * to line up with the fake microphone, which plays its file over and over from when it starts.
 */
const RECORDINGS: { speech: string; heard: string[] }[] = [
  // Long and repetitive after a pause, which Whisper once dropped as a decoding loop.
  {
    speech: `Please replace this undefined with [[slnc 1200]] ${Array.from({ length: 20 }, (_, i) => i + 1).join(" plus ")}`,
    heard: ["undefined", "19", "20"],
  },
];
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

/**
 * A recording of `speech`, with a second of quiet first, as the microphone takes a moment to
 * start. At 16kHz, it's as the app sends recordings to the server.
 */
function record(speech: string, name: string, rate = 48_000): string {
  const recording = join(tmpdir(), `workshop-check-dictation-${name}.wav`);
  const spoken = join(tmpdir(), `workshop-check-dictation-${name}.aiff`);
  execFileSync("say", ["-o", spoken, speech]);
  execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-t",
    "1",
    "-i",
    `anullsrc=r=${rate}:cl=mono`,
    "-i",
    spoken,
    "-filter_complex",
    `[1]aresample=${rate}[s];[0][s]concat=n=2:v=0:a=1`,
    recording,
  ]);
  return recording;
}

async function check(test: Case, recording: string, token: string): Promise<void> {
  // Chrome's microphone plays one file, chosen as it starts.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${recording}`,
    ],
  });
  try {
    const context = await browser.newContext({ ...devices["Pixel 7"] });
    await context.grantPermissions(["microphone"]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`);
    if (await page.locator(".picker").isVisible()) {
      await page.getByRole("button", { name: "2017" }).click();
      await page.locator(".day", { hasText: /^4$/ }).click();
    }
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.locator(".cm-line").first().waitFor();

    for (let press = 1; press <= test.presses; press++) {
      const states = await hold(page, test.holdMs);
      console.log(`press ${press}:\n  ${states.join("\n  ")}`);
      const card = page.locator(".card", { hasText: "“" }).last();
      await card.waitFor({ timeout: 30_000 });
      const heard = (await card.locator(".card-transcript").textContent()) ?? "";
      console.log(`  heard: ${heard}`);
      const missing = test.heard.filter((word) => !heard.toLowerCase().includes(word));
      if (missing.length > 0) throw new Error(`Didn't hear ${missing.join(", ")} in "${heard}".`);
    }
  } finally {
    await browser.close();
  }
}

async function transcribe(
  test: (typeof RECORDINGS)[number],
  recording: string,
  token: string,
): Promise<void> {
  const base = `http://127.0.0.1:${PORT}`;
  const login = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Logging in to the server set no cookie.");
  const response = await fetch(`${base}/api/speech/transcribe`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream" },
    body: readFileSync(recording),
  });
  if (!response.ok) throw new Error(`Transcribing failed: ${await response.text()}`);
  const { text } = (await response.json()) as { text: string };
  console.log(`sent a recording:\n  heard: ${text}`);
  const missing = test.heard.filter((word) => !text.toLowerCase().includes(word));
  if (missing.length > 0) throw new Error(`Didn't hear ${missing.join(", ")} in "${text}".`);
}

async function main(): Promise<void> {
  const recordings = CASES.map((test, i) => record(test.speech, String(i)));
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

  const server = spawn(join(ROOT, "target", "debug", "workshop"), ["serve"], {
    env: { ...process.env, WORKSHOP_HOME: HOME, RUST_LOG: "workshop=info" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const token = readFileSync(join(HOME, "config", "token"), "utf8").trim();
    for (const [i, test] of CASES.entries()) {
      await check(test, recordings[i] as string, token);
    }
    for (const [i, test] of RECORDINGS.entries()) {
      await transcribe(test, record(test.speech, `direct-${i}`, 16_000), token);
    }
  } finally {
    server.kill("SIGTERM");
  }
}

await main();
