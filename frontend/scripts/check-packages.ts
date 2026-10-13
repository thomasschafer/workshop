// Checks packages and helpers against the real toolchains: a solution imports the shared helpers
// and a module that isn't installed, the language server reports the missing one, Workshop finds
// its package online and installs it, the error clears and the solution runs. Needs the network, cabal, GHC and
// haskell-language-server, and Python with pyright, so it isn't part of CI.
//
// Run with `mise run check-packages`, after building the server and frontend.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, devices, type Page } from "@playwright/test";
import { writeHome } from "../e2e/fixture.ts";

const PORT = 7896;
const ROOT = resolve(import.meta.dirname, "..", "..");

interface Case {
  language: "python" | "haskell";
  file: string;
  /** Imports a module whose package isn't in the profile's own list, so it's looked up. */
  code: string;
  package: string;
}

const CASES: Case[] = [
  {
    language: "python",
    file: "main.py",
    code: `import sys

import more_itertools
from aoc import ints


def part1(data: str) -> int:
    return more_itertools.ilen(data.splitlines()) + len(ints(""))


if __name__ == "__main__":
    print(part1(sys.stdin.read()))
`,
    package: "more-itertools",
  },
  {
    language: "haskell",
    file: "Main.hs",
    code: `module Main where

import Aoc (ints)
import Data.List.Extra (trim)

main :: IO ()
main = getContents >>= print . (+ length (ints "")) . length . lines . trim
`,
    package: "extra",
  },
];

// Invented, like every puzzle in tests.
const PUZZLE = `<html><body><main><article class="day-desc"><h2>--- Day 4: Lines ---</h2>
<p>For example:</p><pre><code>a
b
</code></pre></article></main></body></html>`;

async function check(
  page: Page,
  test: Case,
  solution: string,
  log: (message: string) => void,
): Promise<void> {
  const banner = page.locator(".banner");
  const open = async () => {
    await page.getByRole("button", { name: "2017" }).click();
    await page.locator(".day", { hasText: /^4$/ }).click();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.locator(".cm-line").first().waitFor();
  };
  await open();
  // Opening the puzzle created the solution and the helpers; now it's written, as if dictated.
  writeFileSync(solution, test.code);
  await page.reload();
  await open();
  // A language with default packages offers to install them first.
  if (test.language === "haskell") {
    await banner.getByText("aren't installed yet").waitFor({ timeout: 30_000 });
    await banner.getByRole("button", { name: "Install" }).click();
    log("installing the defaults");
  }
  const install = banner.getByRole("button", { name: `Install ${test.package}` });
  await install.waitFor({ timeout: 600_000 });
  log(`offered: ${await banner.textContent()}`);
  await install.click();
  await page.locator(".card").getByText(`Installed ${test.package}`).waitFor({ timeout: 900_000 });
  log("installed");
  await page.locator(".status-line").getByText("no errors").waitFor({ timeout: 300_000 });
  log("the language server sees it");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Run sample" }).click();
  await page.locator(".run-result").getByText("Part 1: 2").waitFor({ timeout: 300_000 });
  log("the solution runs");
}

async function run(test: Case): Promise<void> {
  const home = join(tmpdir(), `workshop-check-packages-${test.language}`);
  writeHome({
    home,
    port: PORT,
    year: 2017,
    day: 4,
    puzzle: PUZZLE,
    input: "a\n",
    stars: {},
    model: "fake",
  });
  // The fixture's Python profile installs with a stand-in for pip; this uses the real one.
  const config = join(home, "config", "config.toml");
  const text = readFileSync(config, "utf8");
  writeFileSync(
    config,
    text
      .slice(0, text.indexOf("[languages.python]"))
      .replace('language = "python"', `language = "${test.language}"`),
  );
  const solution = join(home, "solutions", "2017", "day04", test.file);

  const server = spawn(join(ROOT, "target", "debug", "workshop"), ["serve"], {
    env: { ...process.env, WORKSHOP_HOME: home, RUST_LOG: "workshop=warn" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
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

for (const test of CASES) await run(test);
