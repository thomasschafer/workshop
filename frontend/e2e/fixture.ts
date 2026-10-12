// Builds a self-contained Workshop home for end-to-end tests: Python, a stand-in model, and an
// invented puzzle already in the cache, so tests need no network, toolchain or model access.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PORT = 7899;
export const HOME = join(tmpdir(), "workshop-e2e");

const PUZZLE = `<html><body><main>
<article class="day-desc"><h2>--- Day 4: Counting Lines ---</h2>
<p>The elves keep a list. How long is it?</p>
<p>For example:</p>
<pre><code>apple
pear
plum
</code></pre>
<p>This list has <code><em>3</em></code> items.</p>
</article>
</main></body></html>`;

export interface HomeOptions {
  home: string;
  port: number;
  year: number;
  day: number;
  /** The puzzle page, as Advent of Code would serve it. Never a real puzzle. */
  puzzle: string;
  input: string;
  /** The stand-in model, or the default model provider for real model calls. */
  model: "fake" | "default";
}

/** Writes a Workshop home for Python, with the puzzle and input already in the cache. */
export function writeHome(options: HomeOptions): void {
  const { home, port, year, day, puzzle, input, model } = options;
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, "config"), { recursive: true });
  const fakeModel = resolve(import.meta.dirname, "fake-model.mjs");
  const models =
    model === "fake"
      ? `
[providers.fake]
command = ["node", ${JSON.stringify(fakeModel)}]
input = "stdin"
output = "text"
edit_models = ["fake"]
discuss_models = ["fake"]

[models.edit]
provider = "fake"
model = "fake"

[models.discuss]
provider = "fake"
models = ["fake"]
`
      : "";
  writeFileSync(
    join(home, "config", "config.toml"),
    `[server]
bind = "127.0.0.1:${port}"

[solutions]
dir = "${join(home, "solutions")}"
language = "python"

# Nothing listens here, so no request ever reaches Advent of Code.
[aoc]
base_url = "http://127.0.0.1:9"
${models}`,
  );
  writeFileSync(join(home, "config", "aoc-session"), "not-a-real-session");
  const cached = join(home, "cache", "aoc", String(year), String(day).padStart(2, "0"));
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(cached, "problem.html"), puzzle);
  writeFileSync(join(cached, "input.txt"), input);
}

export function createHome(): void {
  writeHome({
    home: HOME,
    port: PORT,
    year: 2017,
    day: 4,
    puzzle: PUZZLE,
    input: "a\nb\nc\nd\ne\n",
    model: "fake",
  });
}
