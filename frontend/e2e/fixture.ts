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

export function createHome(): void {
  rmSync(HOME, { recursive: true, force: true });
  const fakeModel = resolve(import.meta.dirname, "fake-model.mjs");
  mkdirSync(join(HOME, "config"), { recursive: true });
  writeFileSync(
    join(HOME, "config", "config.toml"),
    `[server]
bind = "127.0.0.1:${PORT}"

[solutions]
dir = "${join(HOME, "solutions")}"
language = "python"

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
`,
  );
  // Never sent anywhere: the puzzle and input are already cached.
  writeFileSync(join(HOME, "config", "aoc-session"), "e2e");
  const day = join(HOME, "cache", "aoc", "2017", "04");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "problem.html"), PUZZLE);
  writeFileSync(join(day, "input.txt"), "a\nb\nc\nd\ne\n");
}
