// Takes the README's screenshots, in docs/screenshots: Workshop on an emulated phone and on a
// computer, in its dark and light themes, with the sample pack and an invented puzzle. The
// model and the language server are the browser tests' stand-ins, so this makes no model calls.
//
// Run with `mise run screenshots`, after building the server and frontend.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Browser,
  type BrowserContextOptions,
  chromium,
  devices,
  type Page,
} from "@playwright/test";
import { serverToken, writeHome } from "../e2e/fixture.ts";
import { DAY, INPUT, PUZZLE, STARS, YEAR } from "./puzzle.ts";

const PORT = 7899;
const HOME = join(tmpdir(), "workshop-screenshots");
const ROOT = resolve(import.meta.dirname, "..", "..");
const OUTPUT = join(ROOT, "docs", "screenshots");
const BASE = `http://127.0.0.1:${PORT}`;

const SOLUTION = `import sys


def part1(data: str) -> int:
    rows = data.splitlines()
    return max(sum(map(int, row.split())) for row in rows)


def part2(data: str) -> int:
    raise NotImplementedError


if __name__ == "__main__":
    data = sys.stdin.read()
    print(part1(data))
`;

const THEMES = ["dark", "light"] as const;

const PHONE: BrowserContextOptions = devices["Pixel 7"];
const COMPUTER: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
};

async function open(browser: Browser, device: BrowserContextOptions, path: string): Promise<Page> {
  const context = await browser.newContext({ ...device, colorScheme: "dark", baseURL: BASE });
  await context.addInitScript(() => {
    localStorage.setItem("workshop:keybindings", "helix");
    // A phone screen is too narrow for the longest lines.
    localStorage.setItem("workshop:line-wrapping", "true");
  });
  const page = await context.newPage();
  await page.goto(`${path}?token=${token}`);
  return page;
}

/** Saves the page as it is in each theme, then closes it. */
async function save(page: Page, name: string): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    // Let fades and the language server's first answers settle.
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUTPUT, `${name}-${theme}.png`) });
  }
  await page.context().close();
}

async function home(): Promise<void> {
  const page = await open(browser, PHONE, "/");
  await page.locator(".continue").waitFor();
  await save(page, "home");
}

/** Opens the invented puzzle, from the list of days unless it opens straight to it. */
async function openPuzzle(page: Page): Promise<void> {
  const day = page.locator(".day", { hasText: new RegExp(`^${DAY}$`) });
  const puzzle = page.locator(".problem").getByText("Lantern Rows");
  await day.or(puzzle).first().waitFor();
  if (await day.isVisible()) await day.click();
  await puzzle.waitFor();
}

async function adventOfCode(): Promise<void> {
  const page = await open(browser, PHONE, "/advent-of-code");
  await openPuzzle(page);
  await page.getByRole("navigation").getByRole("button", { name: "Code" }).click();
  await page.locator(".cm-content").getByText("def part1").waitFor();
  await save(page, "advent-of-code");
}

async function coding(): Promise<void> {
  const page = await open(browser, PHONE, "/coding/sample/first-repeat");
  await page.getByLabel("What should it print?").fill("the");
  await page.getByRole("button", { name: "Check" }).click();
  await page.getByRole("button", { name: "Next: plan" }).click();
  await page.getByLabel("How will you solve it?").fill("Keep a set of the words seen so far.");
  await page.getByRole("button", { name: "Next: code" }).click();
  await page.locator(".cm-content").getByText("def first_repeat").waitFor();
  await page.getByRole("button", { name: "Type" }).click();
  await page.locator(".keyboard").waitFor();
  await save(page, "coding");
}

/** A number as a fraction with a small denominator, as someone would answer, or as it is. */
function fraction(value: number): string {
  for (let denominator = 1; denominator <= 100; denominator++) {
    const numerator = Math.round(value * denominator);
    if (Math.abs(numerator / denominator - value) < 1e-9) {
      return denominator === 1 ? String(numerator) : `${numerator}/${denominator}`;
    }
  }
  return String(value);
}

async function practice(): Promise<void> {
  const page = await open(browser, PHONE, "/practice/probability");
  const prompt = page.locator(".learn-prompt");
  await prompt.waitFor();
  const shown = ((await prompt.textContent()) ?? "").replace(/\s+/g, " ").trim();
  // The answer, from the deck the app keeps for practising offline.
  const answer = await page.evaluate((shown) => {
    const saved = JSON.parse(localStorage.getItem("workshop:learning") ?? "null") as {
      deck: { items: { kind: string; prompt: string; answer?: string | number }[] };
    } | null;
    return saved?.deck.items.find(
      (item) => item.kind === "probability" && item.prompt.replace(/\s+/g, " ").trim() === shown,
    )?.answer;
  }, shown);
  if (answer === undefined) throw new Error(`No answer found for "${shown}".`);
  await page.getByLabel("Your answer").fill(fraction(Number(answer)));
  await page.getByRole("button", { name: "Check" }).click();
  await page.locator(".learn-verdict").getByText("Right").waitFor();
  await save(page, "practice");
}

async function desktop(): Promise<void> {
  const page = await open(browser, COMPUTER, "/advent-of-code");
  await openPuzzle(page);
  await page.locator(".cm-content").getByText("def part1").waitFor();
  await save(page, "desktop");
}

writeHome({
  home: HOME,
  port: PORT,
  year: YEAR,
  day: DAY,
  puzzle: PUZZLE,
  input: INPUT,
  stars: { ...STARS },
  model: "fake",
  helix: false,
});
const solution = join(HOME, "solutions", String(YEAR), `day${String(DAY).padStart(2, "0")}`);
mkdirSync(solution, { recursive: true });
writeFileSync(join(solution, "main.py"), SOLUTION);
mkdirSync(OUTPUT, { recursive: true });

// Before the server starts, so a browser that won't launch doesn't leave it running.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
let token = "";
const server = spawn(join(ROOT, "target", "debug", "workshop"), ["serve"], {
  env: { ...process.env, WORKSHOP_HOME: HOME, RUST_LOG: process.env.RUST_LOG ?? "workshop=warn" },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  token = await serverToken(HOME, PORT);
  for (const take of [home, adventOfCode, coding, practice, desktop]) await take();
  console.log(`Saved the screenshots in ${OUTPUT}`);
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
