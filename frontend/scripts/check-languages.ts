// Checks each language against its real toolchain, through the app: opening a puzzle creates the
// solution and the helpers, the language server reports an error and then sees it fixed, and a
// solution using the helpers runs on the sample. Needs each language's programs installed, so it
// isn't part of CI.
//
// Run with `mise run check-languages`, after building the server and frontend. Name languages to
// check only those: `mise run check-languages -- go rust`.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, devices, type Page } from "@playwright/test";
import { writeHome } from "../e2e/fixture.ts";

const PORT = 7895;
const ROOT = resolve(import.meta.dirname, "..", "..");

interface Case {
  language: string;
  file: string;
  /** A solution with one type error in it. */
  broken: string;
  /** Sums the integers in the input with the helpers' `ints`. */
  working: string;
}

const CASES: Case[] = [
  {
    language: "haskell",
    file: "Main.hs",
    broken: `module Main where

main :: IO ()
main = putStrLn (1 :: Int)
`,
    working: `module Main where

import Aoc (ints)

main :: IO ()
main = getContents >>= print . sum . ints
`,
  },
  {
    language: "python",
    file: "main.py",
    broken: `answer: int = "not a number"
print(answer)
`,
    working: `import sys

from aoc import ints

print(sum(ints(sys.stdin.read())))
`,
  },
  {
    language: "go",
    file: "main.go",
    broken: `package main

func main() {
	var answer int = "not a number"
	_ = answer
}
`,
    working: `package main

import (
	"fmt"
	"io"
	"os"

	"solutions/aoc"
)

func main() {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		panic(err)
	}
	fmt.Println(aoc.Sum(aoc.Ints(string(data))))
}
`,
  },
  {
    language: "typescript",
    file: "main.ts",
    broken: `const answer: number = "not a number";
console.log(answer);
`,
    working: `import { ints } from "aoc";

function part1(input: string): number {
  return ints(input).reduce((a, b) => a + b, 0);
}

const input = await new Response(Deno.stdin.readable).text();
console.log(part1(input));
`,
  },
];

// Invented, like every puzzle in tests.
const PUZZLE = `<html><body><main><article class="day-desc"><h2>--- Day 4: Sums ---</h2>
<p>For example:</p><pre><code>1 2
-4 10
</code></pre></article></main></body></html>`;
const SAMPLE_ANSWER = "9";

async function check(
  page: Page,
  test: Case,
  solution: string,
  log: (message: string) => void,
): Promise<void> {
  const status = page.locator(".status-line");
  const open = async () => {
    await page.getByRole("button", { name: "2017" }).click();
    await page.locator(".day", { hasText: /^4$/ }).click();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.locator(".cm-line").first().waitFor();
  };
  // Opening the puzzle creates the solution and the helpers; each version after that is written
  // as if dictated.
  await open();
  const reopen = async (code: string) => {
    writeFileSync(solution, code);
    await page.reload();
    await open();
  };
  await reopen(test.broken);
  await status.getByText(/\b1 error\b/).waitFor({ timeout: 300_000 });
  log("the language server reports the error");
  await reopen(test.working);
  await status.getByText("no errors").waitFor({ timeout: 300_000 });
  // "no errors" shows as soon as the server is ready, so this waits for it to have had a look.
  await page.waitForTimeout(5000);
  await status.getByText("no errors").waitFor();
  log("and sees it fixed");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Run sample" }).click();
  await page
    .locator(".run-result")
    .getByText(`Part 1: ${SAMPLE_ANSWER}`)
    .waitFor({ timeout: 300_000 });
  log("the solution runs");
}

async function run(test: Case): Promise<void> {
  const home = join(tmpdir(), `workshop-check-languages-${test.language}`);
  writeHome({
    home,
    port: PORT,
    year: 2017,
    day: 4,
    puzzle: PUZZLE,
    input: "1\n",
    stars: {},
    model: "fake",
  });
  // The fixture's own Python profile uses stand-ins; this uses the built-in profiles.
  const config = join(home, "config", "config.toml");
  const text = readFileSync(config, "utf8");
  writeFileSync(
    config,
    text
      .slice(0, text.indexOf("[languages.python]"))
      .replace('language = "python"', `language = "${test.language}"`),
  );
  const solution = join(home, "solutions", "2017", "day04", test.file);

  // Before the server starts, so a browser that won't launch doesn't leave it running.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const server = spawn(join(ROOT, "target", "debug", "workshop"), ["serve"], {
    env: { ...process.env, WORKSHOP_HOME: home, RUST_LOG: "workshop=warn" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const started = Date.now();
  const log = (message: string) =>
    console.log(`${test.language} ${((Date.now() - started) / 1000).toFixed(1)}s: ${message}`);
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const token = readFileSync(join(home, "config", "token"), "utf8").trim();
    const page = await browser.newPage({ ...devices["Pixel 7"] });
    await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`);
    try {
      await check(page, test, solution, log);
    } catch (err) {
      const screenshot = join(home, "failure.png");
      await page.screenshot({ path: screenshot });
      throw new Error(`${test.language} failed; the page at that point is in ${screenshot}.`, {
        cause: err,
      });
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

const chosen = process.argv.slice(2);
const unknown = chosen.filter((language) => !CASES.some((c) => c.language === language));
if (unknown.length > 0) throw new Error(`No check for ${unknown.join(", ")}.`);
for (const test of CASES) {
  if (chosen.length === 0 || chosen.includes(test.language)) await run(test);
}
