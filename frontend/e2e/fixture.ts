// Builds a self-contained Workshop home for end-to-end tests: Python, a stand-in model, and an
// invented puzzle already in the cache, so tests need no network, toolchain or model access.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Each checkout has its own block of ports, one for each server, and its own homes, so the tests
// can run in several worktrees at once.
const checkout = createHash("sha256")
  .update(resolve(import.meta.dirname))
  .digest();
const SERVERS = 4;
const FIRST_PORT = 20_000 + (checkout.readUInt16BE(0) % Math.floor(10_000 / SERVERS)) * SERVERS;
const CHECKOUT_HOME = join(tmpdir(), `workshop-e2e-${checkout.toString("hex").slice(0, 12)}`);

/** The port of this checkout's `index`th server, in a block no other checkout's overlaps. */
function port(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= SERVERS) {
    throw new Error(`Each checkout has ports for ${SERVERS} servers, not server ${index}.`);
  }
  return FIRST_PORT + index;
}

export const PORT = port(0);
export const HOME = CHECKOUT_HOME;

/** A second server, for learning from the sample pack, so its tests start with nothing done. */
export const LEARNING_PORT = port(1);
export const LEARNING_HOME = `${CHECKOUT_HOME}-learning`;

/** A third, for the Coding track, whose problems' steps and attempts are its own. */
export const CODING_PORT = port(2);
export const CODING_HOME = `${CHECKOUT_HOME}-coding`;

/** A fourth, with a pack of its own in a git repo, for the author, importing and fixing cards. */
export const AUTHOR_PORT = port(3);
export const AUTHOR_HOME = `${CHECKOUT_HOME}-author`;

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

/** A built-in language profile, changed by `replacements`, as config of its own. */
function profile(id: string, replacements: [RegExp, string][]): string {
  const builtin = readFileSync(resolve(import.meta.dirname, `../../languages/${id}.toml`), "utf8");
  let changed = builtin;
  for (const [pattern, replacement] of [
    ...replacements,
    [/^\[(packages|helpers|toolchain)/gm, `[languages.${id}.$1`] as [RegExp, string],
  ]) {
    if (!pattern.test(changed)) throw new Error(`${id}.toml no longer matches ${pattern}`);
    changed = changed.replace(pattern, replacement);
  }
  return `[languages.${id}]\n${changed}`;
}

const fakeLsp = resolve(import.meta.dirname, "fake-lsp.mjs");
/** A stand-in for the language server, so its errors and answers are the tests' own. */
const FAKE_LSP: [RegExp, string] = [/^lsp = .*$/m, `lsp = ["node", ${JSON.stringify(fakeLsp)}]`];

/**
 * The built-in Python profile, with packages installed by a stand-in for pip, no lookups on
 * PyPI and a stand-in for the language server, so nothing needs the network or Pyright.
 * Everything else, such as how missing modules are
 * recognised, is as built.
 */
function pythonProfile(): string {
  const fakeInstall = resolve(import.meta.dirname, "fake-install.mjs");
  return profile("python", [
    [
      /^install = \[\n[\s\S]*?^\]\n/m,
      `install = [["node", ${JSON.stringify(fakeInstall)}, "{env}", "{packages}"]]\n`,
    ],
    [/^environment = \{ PATH = .*$/m, 'environment = { PYTHONPATH = "{env}/site" }'],
    [/^lookup = .*\n/m, ""],
    FAKE_LSP,
    // Formatting is the stand-in language server's, rather than Ruff's.
    [/^formatter = .*\n/m, ""],
  ]);
}

/**
 * The built-in Haskell profile with a stand-in for its language server, for coding problems in
 * Haskell, so nothing needs haskell-language-server.
 */
function haskellProfile(): string {
  return profile("haskell", [FAKE_LSP]);
}

/**
 * A file that has the stand-in language server fail as it starts, saying why, when it's in the
 * directory the server's started in.
 */
export const FAKE_LSP_FAILS = "fake-lsp-fails";

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
  /** More config, appended. */
  extra?: string;
  /**
   * The author's settings. Its reviewer is set, so the server never checks whether a real
   * model CLI is installed and logged in to choose one.
   */
  author?: string;
}

/** Writes a Workshop home for Python, with the puzzle and input already in the cache. */
export function writeHome(options: HomeOptions): void {
  const {
    home,
    port,
    year,
    day,
    puzzle,
    input,
    stars,
    model,
    extra = "",
    author = model === "fake" ? '[author]\nreviewer = { provider = "fake", model = "fake" }\n' : "",
  } = options;
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, "config"), { recursive: true });
  const fakeModel = resolve(import.meta.dirname, "fake-model.mjs");
  const models =
    model === "fake"
      ? `
[providers.fake]
command = ["node", ${JSON.stringify(fakeModel)}, "{system_prompt}"]
input = "stdin"
output = "claude-stream-json"
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
# Quoted as JSON quotes strings, which TOML reads the same, so Windows' backslashes survive.
dir = ${JSON.stringify(join(home, "solutions"))}
language = "python"

# Nothing listens here, so no request ever reaches Advent of Code.
[aoc]
base_url = "http://127.0.0.1:9"

# Off until a device turns them on, with keys of one's own.
[editor.helix]
line-number = "relative"
color-modes = true

[editor.helix.keys.normal]
X = "extend_line_above"
A-up = [
  "ensure_selections_forward",
  "extend_to_line_bounds",
  "extend_char_right",
  "extend_char_left",
  "delete_selection",
  "move_line_up",
  "add_newline_above",
  "move_line_up",
  "replace_with_yanked",
]

[editor.helix.keys.normal.space]
x = ["yank_to_clipboard", "delete_selection"]
${models}
${author}
${extra}
${pythonProfile()}
${haskellProfile()}`,
  );
  writeFileSync(join(home, "config", "aoc-session"), "not-a-real-session");
  // A newer release, as if just checked for, so the server doesn't ask GitHub during the tests.
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(
    join(home, "data", "latest-release.json"),
    JSON.stringify({ latest: "999.0.0", checked_at: Math.floor(Date.now() / 1000) }),
  );
  const cached = join(home, "cache", "aoc", String(year), String(day).padStart(2, "0"));
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(cached, "problem.html"), puzzle);
  writeFileSync(join(cached, "input.txt"), input);
  writeFileSync(join(home, "cache", "aoc", String(year), "calendar.html"), calendar(year, stars));
  // Invented times, laid out as Advent of Code lays out personal stats.
  writeFileSync(
    join(home, "cache", "aoc", String(year), "times.html"),
    "<main><pre>Day   -Part 1-   -Part 2-\n  1   01:02:03   01:30:00\n</pre></main>",
  );
  // An invented private leaderboard, as fresh as if just fetched.
  writeFileSync(
    join(home, "cache", "aoc", String(year), "leaderboard-123456.json"),
    JSON.stringify({
      members: {
        "1": { id: 1, name: "Ada", local_score: 40, stars: 6 },
        "2": { id: 2, name: null, local_score: 52, stars: 7 },
      },
    }),
  );
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

/** A home for learning from the sample pack, as when no pack is configured. */
export function createLearningHome(): void {
  writeHome({
    home: LEARNING_HOME,
    port: LEARNING_PORT,
    year: 2017,
    day: 4,
    puzzle: PUZZLE,
    input: "a\n",
    stars: {},
    model: "fake",
    // The tests start more new items than a day's default allows.
    extra: "[learning]\ndaily_new = 100\n",
  });
}

/** The pack of the Coding track's home that keeps its own track, Drills, out of Continue. */
export const DRILLS_PACK = "drills";

/**
 * A home for the Coding track, with the sample pack's problems and code to read, and a pack
 * whose items are all in a track kept out of Continue: cards, code to read and a problem.
 */
export function createCodingHome(): void {
  const drills = join(CODING_HOME, DRILLS_PACK);
  writeHome({
    home: CODING_HOME,
    port: CODING_PORT,
    year: 2017,
    day: 4,
    puzzle: PUZZLE,
    input: "a\n",
    stars: {},
    model: "fake",
    extra: `[learning]\npacks = [${JSON.stringify(drills)}]\nsample_pack = true\n`,
  });
  const files: Record<string, string> = {
    "pack.toml": `id = "drills"
name = "Drills"
track = "drills"

[[skills]]
id = "drills.sums"
name = "Drilled sums"

[[tracks]]
id = "drills"
name = "Drills"
summary = "Practised only when opened"
icon = "puzzle"
continue = false

[[goals]]
id = "drilled-sums"
name = "Drilled sums"
skills = ["drills.sums"]
`,
    "items/cards/seven-eights.md":
      '+++\nkind = "card"\nskills = ["drills.sums"]\n+++\nWhat are seven eights?\n\n## Answer\n\n56\n',
    "items/cards/nine-sixes.md":
      '+++\nkind = "card"\nskills = ["drills.sums"]\n+++\nWhat are nine sixes?\n\n## Answer\n\n54\n',
    "items/reading/doubled.md":
      '+++\nkind = "reading"\nskills = ["drills.sums"]\nprints = "14"\n+++\nWhat does this print?\n\n```python\nprint(sum(x * 2 for x in [3, 4]))\n```\n\n## Explanation\n\nEach doubled, then added.\n',
    "items/add-them-up/item.md":
      '+++\nkind = "coding"\ntitle = "Add them up"\nskills = ["drills.sums"]\nlanguages = ["python"]\nreference = ["reference.py"]\nstarter = ["starter.py"]\nbrute_force = "reference.py"\ninputs = "inputs.py"\ntests = "tests.toml"\n+++\nPrint the sum of the numbers on the line.\n\n## Approach\n\nAdd them up.\n',
    "items/add-them-up/reference.py": "print(sum(map(int, input().split())))\n",
    "items/add-them-up/starter.py": "numbers = list(map(int, input().split()))\n",
    "items/add-them-up/inputs.py":
      "import random, sys\nrng = random.Random(int(sys.argv[1]))\nprint(*[rng.randint(-9, 9) for _ in range(int(sys.argv[2]))])\n",
    "items/add-them-up/tests.toml":
      '[[example]]\ninput = "1 2"\noutput = "3"\n[[test]]\ninput = "4"\noutput = "4"\n',
  };
  for (const [path, text] of Object.entries(files)) {
    const file = join(drills, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
}

/**
 * Waits for a server started on `home` to answer, then returns its login token. A freshly built
 * server can take a while to start, such as while macOS checks it the first time.
 */
export async function serverToken(home: string, port: number, timeoutMs = 60_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return readFileSync(join(home, "config", "token"), "utf8").trim();
    } catch (err) {
      if (Date.now() > until) {
        throw new Error(`The server on port ${port} didn't start within ${timeoutMs / 1000}s.`, {
          cause: err,
        });
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** A design prompt in the author's pack whose brief is left out, for the coach to make one up. */
export const UNBRIEFED_DESIGN = "rate-limiter";

/**
 * A home whose pack is a copy of the sample pack in a git repo of its own, with stand-ins for
 * the author's writer and reviewer, so the author runs without calling any model. One of its
 * design prompts has no brief of its own.
 */
export function createAuthorHome(): void {
  const pack = join(AUTHOR_HOME, "pack");
  const writer = resolve(import.meta.dirname, "fake-author.mjs");
  const reviewer = resolve(import.meta.dirname, "fake-reviewer.mjs");
  const fakeModel = resolve(import.meta.dirname, "fake-model.mjs");
  writeHome({
    home: AUTHOR_HOME,
    port: AUTHOR_PORT,
    year: 2017,
    day: 4,
    puzzle: PUZZLE,
    input: "a\n",
    stars: {},
    model: "fake",
    author: `[author]
writer = { provider = "fakewriter", model = "writer" }
reviewer = { provider = "fakereviewer", model = "reviewer" }
max_items = 3
every = "7d"
`,
    extra: `
[providers.fakewriter]
command = ["node", ${JSON.stringify(fakeModel)}]
input = "stdin"
output = "claude-stream-json"

[providers.fakewriter.agent]
command = ["node", ${JSON.stringify(writer)}, "{dir}"]
output = "text"

[providers.fakereviewer]
command = ["node", ${JSON.stringify(reviewer)}]
input = "stdin"
output = "text"


[learning]
packs = [${JSON.stringify(pack)}]
`,
  });
  // Scheduled weekly, and run just now, so the server shows when it's next due without running
  // it during the tests.
  mkdirSync(join(AUTHOR_HOME, "data", "author"), { recursive: true });
  writeFileSync(
    join(AUTHOR_HOME, "data", "author", "schedule.json"),
    JSON.stringify({ last_started_at: Date.now() }),
  );
  cpSync(resolve(import.meta.dirname, "../../packs/sample"), pack, { recursive: true });
  const unbriefed = join(pack, "items", "design", `${UNBRIEFED_DESIGN}.md`);
  const text = readFileSync(unbriefed, "utf8");
  const brief = text.indexOf("\n## Brief\n");
  if (brief === -1) throw new Error(`${unbriefed} has no brief to leave out`);
  writeFileSync(unbriefed, `${text.slice(0, brief).trimEnd()}\n`);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: pack,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Workshop tests",
        GIT_AUTHOR_EMAIL: "tests@example.com",
        GIT_COMMITTER_NAME: "Workshop tests",
        GIT_COMMITTER_EMAIL: "tests@example.com",
      },
    });
  git("init", "--quiet", "--initial-branch", "main");
  git("add", ".");
  git("commit", "--quiet", "-m", "Start");
}
