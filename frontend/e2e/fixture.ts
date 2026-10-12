// Builds a self-contained Workshop home for end-to-end tests: Python, a stand-in model, and an
// invented puzzle already in the cache, so tests need no network, toolchain or model access.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The built-in Python profile, with packages installed by a stand-in for pip and no lookups on
 * PyPI, so nothing needs the network. Everything else, such as how missing modules are
 * recognised, is as built.
 */
function pythonProfile(): string {
  const builtin = readFileSync(resolve(import.meta.dirname, "../../languages/python.toml"), "utf8");
  const fakeInstall = resolve(import.meta.dirname, "fake-install.mjs");
  const replacements: [RegExp, string][] = [
    [
      /^install = \[\n[\s\S]*?^\]\n/m,
      `install = [["node", ${JSON.stringify(fakeInstall)}, "{env}", "{packages}"]]\n`,
    ],
    [/^environment = .*$/m, 'environment = { PYTHONPATH = "{env}/site" }'],
    [/^lookup = .*\n/m, ""],
    [/^\[packages/gm, "[languages.python.packages"],
  ];
  let profile = builtin;
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(profile)) throw new Error(`python.toml no longer matches ${pattern}`);
    profile = profile.replace(pattern, replacement);
  }
  return `[languages.python]\n${profile}`;
}

export interface HomeOptions {
  home: string;
  port: number;
  year: number;
  day: number;
  /** The puzzle page, as Advent of Code would serve it. Never a real puzzle. */
  puzzle: string;
  input: string;
  /** Stars per day for the year's calendar. */
  stars: Record<number, 0 | 1 | 2>;
  /** The stand-in model, or the default model provider for real model calls. */
  model: "fake" | "default";
}

/** Writes a Workshop home for Python, with the puzzle and input already in the cache. */
export function writeHome(options: HomeOptions): void {
  const { home, port, year, day, puzzle, input, stars, model } = options;
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
${models}
${pythonProfile()}`,
  );
  writeFileSync(join(home, "config", "aoc-session"), "not-a-real-session");
  const cached = join(home, "cache", "aoc", String(year), String(day).padStart(2, "0"));
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(cached, "problem.html"), puzzle);
  writeFileSync(join(cached, "input.txt"), input);
  writeFileSync(join(home, "cache", "aoc", String(year), "calendar.html"), calendar(year, stars));
}

/** A calendar page in the form Advent of Code uses, for the stars in the picker. */
function calendar(year: number, stars: Record<number, 0 | 1 | 2>): string {
  const days = Object.entries(stars).map(([day, count]) => {
    const label = ["", ", one star", ", two stars"][count];
    return `<a aria-label="Day ${day}${label}" href="/${year}/day/${day}">${day}</a>`;
  });
  return `<html><body><main><pre class="calendar">\n${days.join("\n")}\n</pre></main></body></html>`;
}

export function createHome(): void {
  writeHome({
    home: HOME,
    port: PORT,
    year: 2017,
    day: 4,
    puzzle: PUZZLE,
    input: "a\nb\nc\nd\ne\n",
    stars: { 1: 2, 2: 2, 3: 1, 4: 0 },
    model: "fake",
  });
}
