// A stand-in for the edit and discussion models, so end-to-end tests make no real model calls.
// It reads the prompt on stdin and replies to the utterances the tests use.
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");

// A discussion prompt lists the conversation, with the user's turns as "Them: ...".
const asked = prompt.match(/^Them: .*$/gm);
if (asked) {
  const question = asked[asked.length - 1].replace(/^Them: /, "");
  process.stdout.write(`You asked "${question}", after ${asked.length} question(s).`);
  process.exit(0);
}

const said = (prompt.match(/^(?:Utterance|Reply): (.*)$/gm) ?? []).map((line) =>
  line.replace(/^\w+: /, ""),
);
const utterance = said[said.length - 1] ?? "";

const PLACEHOLDER = "def part1(data: str) -> int:\n    raise NotImplementedError";
const replies = {
  "return the number of lines": {
    status: "edit",
    edits: [
      {
        find: PLACEHOLDER,
        replace: "def part1(data: str) -> int:\n    return len(data.splitlines())‸",
      },
    ],
    summary: "returned the number of lines",
  },
  "change it": { status: "unsure", message: "Change what: part 1 or part 2?" },
  "part two, make it return zero": {
    status: "edit",
    edits: [
      {
        find: "def part2(data: str) -> int:\n    raise NotImplementedError",
        replace: "def part2(data: str) -> int:\n    return 0‸",
      },
    ],
    summary: "made part 2 return zero",
  },
};

const reply = replies[utterance] ?? {
  status: "unsure",
  message: `The fake model has no reply for "${utterance}".`,
};
process.stdout.write(JSON.stringify(reply));
