// A stand-in for the author's writer, run as an agent in a copy of the pack, so end-to-end tests
// call no model. Without lesson requests, it writes two cards on its first turn and stands by them
// when objected to. With a lesson request, it writes a lesson with 3 new items, links the requested
// item to it, and revises the lesson when the reviewer objects during the audit.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prompt = readFileSync(0, "utf8");
const dir = process.argv[2] ?? ".";
// It's started in the directory it's confined to.
if (realpathSync(process.cwd()) !== realpathSync(dir))
  throw new Error(`run in ${process.cwd()}, not ${dir}`);

const card = (question) =>
  `+++\nkind = "card"\nskills = ["algorithms.complexity"]\n+++\n${question}\n\n## Answer\n\nLinear: each item is looked at once.\n`;

const lesson = (seg1) => `+++
kind = "lesson"
title = "Why sorting stability matters"
skills = ["algorithms.complexity"]

[[sources]]
title = "Python Sorting HOW TO"
url = "https://docs.python.org/3/howto/sorting.html"

[[checks]]
segment = 1
prompt = "If you sort records by name, then stably by city, how are records in the same city ordered?"
choices = ["By name", "Arbitrarily", "In reverse name order"]
answer = 1
explanation = "A stable sort keeps equal-key items in their existing order."
+++
What stability guarantees when sorting records by multiple keys.

## Preserving relative order

${seg1}

![Stable sort keeping equal keys in order](order.svg)

## Explain

Why does stability matter when sorting a table by a secondary key and then a primary key?

## Explain answer

Because equal values on the primary key keep the relative order established by the earlier sort on the secondary key.
`;

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 60"><rect x="10" y="10" width="200" height="40" fill="none" stroke="currentColor"/><text x="110" y="35" text-anchor="middle" fill="currentColor">A1, A2 stay in order</text></svg>\n';

const linkedCard = (question, answer) => `+++
kind = "card"
skills = ["algorithms.complexity"]
lesson = "sorting-stability"
segment = 1
+++
${question}

## Answer

${answer}
`;

if (prompt.includes("<format>") && prompt.includes("Requests for lessons come first")) {
  mkdirSync(join(dir, "items", "lessons", "sorting-stability"), { recursive: true });
  mkdirSync(join(dir, "items", "author"), { recursive: true });
  writeFileSync(
    join(dir, "items", "lessons", "sorting-stability", "item.md"),
    lesson("All fast sorting algorithms are stable and keep equal keys in order."),
  );
  writeFileSync(join(dir, "items", "lessons", "sorting-stability", "order.svg"), svg);
  writeFileSync(
    join(dir, "items", "author", "stability-1.md"),
    linkedCard(
      "Which built-in sort algorithm does Python use, and is it stable?",
      "Timsort (powersort merge strategy), and it is stable.",
    ),
  );
  writeFileSync(
    join(dir, "items", "author", "stability-2.md"),
    linkedCard(
      "Why can an in-place quicksort break stability?",
      "Swapping distant elements around a pivot can reverse equal keys.",
    ),
  );
  writeFileSync(
    join(dir, "items", "author", "stability-3.md"),
    linkedCard(
      "How does radix sort rely on the stability of its per-digit sort?",
      "Less significant digits must stay ordered when higher digits tie.",
    ),
  );
  // Link the requested item in front matter only.
  const match = prompt.match(/^- (items\/[^\s]+) \(id:/m);
  if (match?.[1]) {
    const target = join(dir, match[1]);
    const before = readFileSync(target, "utf8");
    const updated = before.replace(
      /\n\+\+\+\n/,
      '\nlesson = "sorting-stability"\nsegment = 1\n+++\n',
    );
    writeFileSync(target, updated);
  }
  console.log(
    JSON.stringify({
      items: [
        { path: "items/lessons/sorting-stability/item.md" },
        { path: "items/author/stability-1.md" },
        { path: "items/author/stability-2.md" },
        { path: "items/author/stability-3.md" },
      ],
      questions: [],
    }),
  );
} else if (prompt.includes("<format>")) {
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
} else if (prompt.includes("<objection>") && prompt.includes("sorting-stability")) {
  writeFileSync(
    join(dir, "items", "lessons", "sorting-stability", "item.md"),
    lesson("Merge sort and Timsort are stable, whereas a typical in-place quicksort is not."),
  );
  console.log(
    JSON.stringify({
      position: "revised",
      reply: "Clarified that merge sort and Timsort are stable while typical quicksort is not.",
    }),
  );
} else if (prompt.includes("<objection>")) {
  console.log(JSON.stringify({ position: "stands", reply: "A scan looks at each item once." }));
} else {
  console.log(JSON.stringify({ items: [], questions: [] }));
}
