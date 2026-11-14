// A stand-in for the author's writer, run as an agent in a copy of the pack, so end-to-end tests
// call no model. It writes two cards on its first turn, and stands by them when objected to.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prompt = readFileSync(0, "utf8");
const dir = process.argv[2] ?? ".";
// It's started in the directory it's confined to.
if (realpathSync(process.cwd()) !== realpathSync(dir))
  throw new Error(`run in ${process.cwd()}, not ${dir}`);

const card = (question) =>
  `+++\nkind = "card"\nskills = ["algorithms.complexity"]\n+++\n${question}\n\n## Answer\n\nLinear: each item is looked at once.\n`;

if (prompt.includes("<format>")) {
  mkdirSync(join(dir, "items", "author"), { recursive: true });
  writeFileSync(
    join(dir, "items", "author", "linear-scan.md"),
    card("What does finding the largest of n numbers cost?"),
  );
  writeFileSync(join(dir, "items", "author", "vague-scan.md"), card("What does a scan cost?"));
  console.log(
    JSON.stringify({
      items: [{ path: "items/author/linear-scan.md" }, { path: "items/author/vague-scan.md" }],
      questions: ["Would you like more on sorting?"],
    }),
  );
} else if (prompt.includes("<objection>")) {
  console.log(JSON.stringify({ position: "stands", reply: "A scan looks at each item once." }));
} else {
  console.log(JSON.stringify({ items: [], questions: [] }));
}
