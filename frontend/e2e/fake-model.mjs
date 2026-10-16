// A stand-in for the edit and discussion models, so end-to-end tests make no real model calls.
// It reads the prompt on stdin and replies to the utterances the tests use, in the shape of
// Claude Code's stream-json output.
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");

/** Replies as Claude Code's stream-json output does: the text in parts, then the message. */
async function reply(parts, pauseMs = 0) {
  for (const [i, text] of parts.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, pauseMs));
    const delta = { type: "text_delta", text };
    const event = { type: "content_block_delta", index: 0, delta };
    process.stdout.write(`${JSON.stringify({ type: "stream_event", event })}\n`);
  }
  const content = [{ type: "text", text: parts.join("") }];
  process.stdout.write(
    `${JSON.stringify({ type: "assistant", message: { model: "fake", content } })}\n`,
  );
}

// A discussion prompt lists the conversation, with the user's turns as "Them: ...".
const asked = prompt.match(/^Them: .*$/gm);
if (asked) {
  const question = asked[asked.length - 1].replace(/^Them: /, "");
  if (question.includes("format")) {
    await reply(["Some **clues**:\n\n1. Look at `seen`.\n", "2. Try a <b>set</b>.\n"], 700);
  } else {
    // In two parts, with time to see the first before the second.
    await reply([`You asked "${question}", `, `after ${asked.length} question(s).`], 700);
  }
  process.exit(0);
}

const said = (prompt.match(/^(?:Utterance|Reply): (.*)$/gm) ?? []).map((line) =>
  line.replace(/^\w+: /, ""),
);
const utterance = said[said.length - 1] ?? "";

const PLACEHOLDER = "def part1(data: str) -> int:\n    raise NotImplementedError";
const replies = {
  "use the lanterns package": {
    status: "edit",
    edits: [
      { find: "import sys", replace: "import sys\nimport lanterns" },
      { find: "return len(data.splitlines())", replace: "return lanterns.count(data)‸" },
    ],
    summary: "used lanterns",
  },
  "slowly make it return seven": {
    status: "edit",
    edits: [{ find: "return len(data.splitlines())", replace: "return 7‸" }],
    summary: "made it return seven",
  },
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
  "add a long comment": {
    status: "edit",
    edits: [
      {
        find: "import sys",
        replace:
          "import sys  # a comment long enough to run well past the right edge of a phone's screen‸",
      },
    ],
    summary: "added a long comment",
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

const edit = replies[utterance] ?? {
  status: "unsure",
  message: `The fake model has no reply for "${utterance}".`,
};
// Slow enough for a test to act while the edit is still being made.
if (utterance.startsWith("slowly")) await new Promise((r) => setTimeout(r, 1500));
await reply([JSON.stringify(edit)]);
