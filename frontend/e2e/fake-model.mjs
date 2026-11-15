// A stand-in for the edit and discussion models, so end-to-end tests make no real model calls.
// It reads the prompt on stdin and replies to the utterances the tests use, in the shape of
// Claude Code's stream-json output.
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
// The system prompt, which the tests' config passes as the only argument.
const system = process.argv[2] ?? "";

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

// Asked for a part's example: the one in the invented puzzle the tests write inline.
if (prompt.includes("Find part 1's example.") && prompt.includes("+2, -5, +4")) {
  await reply([JSON.stringify({ input: "+2\n-5\n+4", answer: "1" })]);
  process.exit(0);
}

// The coach of a design session, asking follow-up questions about the stage the learner's at.
if (prompt.includes("Ask one or two follow-up questions about this stage.")) {
  const stage = prompt.match(/They're at the stage "([^"]+)"/)?.[1] ?? "?";
  const answered = prompt.includes("\nLearner: ");
  await reply([
    answered
      ? "And what happens to that when traffic grows tenfold?"
      : `At ${stage}: what have you assumed here that might not hold?`,
  ]);
  process.exit(0);
}

// The examiner of a timed round, in the style chosen for it, replying to the learner's last
// message, or welcoming them back after a break.
if (prompt.includes("Reply to their last message as the examiner.")) {
  const style = system.match(/Your style for this round is "([^"]+)"/)?.[1] ?? "No style";
  const said = prompt.match(/^Learner: .*$/gm) ?? [];
  const last = (said[said.length - 1] ?? "").replace(/^Learner: /, "");
  await reply([
    prompt.includes("just come back to the round")
      ? `${style}: welcome back. You said "${last}"; carry on from there.`
      : `${style}: you said "${last}". What if there were three dice instead?`,
  ]);
  process.exit(0);
}

// The tutor, posing a twist on a problem for its review, as the kind it's asked for. For the
// problem of sensor readings it can't, as when no model can be reached.
if (prompt.includes("Pose a twist on it")) {
  if (prompt.includes("A sensor logs a list of readings")) {
    process.stderr.write("The fake tutor can't be reached.\n");
    process.exit(1);
  }
  const kind = prompt.match(/This time, make it ([^,.]+)/)?.[1] ?? "a twist";
  const before = (prompt.match(/^- .*$/gm) ?? []).length;
  await reply([
    JSON.stringify({
      twist: `Twist ${before + 1}, ${kind}: now the input **streams in**, one word at a time.`,
      notes: "Keep what's been seen as it arrives, and answer as soon as a word repeats.",
    }),
  ]);
  process.exit(0);
}

// The grader, marking an answer to a twist: in full, with nothing wrong, if it keeps what's
// been seen as it arrives, and otherwise partly.
if (prompt.includes("<twist>")) {
  const work = prompt.match(/<work>\n([\s\S]*?)\n<\/work>/)?.[1] ?? "";
  const full = work.includes("as it arrives");
  await reply([
    JSON.stringify({
      score: full ? 1 : 0.7,
      points: [{ point: "Says what has to change", met: full ? "yes" : "partly", comment: "" }],
      findings: full
        ? []
        : [{ error_type: "missed-edge-case", detail: `Unclear on memory in "${work}"` }],
      feedback: full ? "That's it." : "Say how much it **remembers**.",
      ...(prompt.includes("explained this aloud")
        ? { clarity: { score: 0.8, feedback: "Clear." } }
        : {}),
    }),
  ]);
  process.exit(0);
}

// The grader, marking written work or checking a card.
if (prompt.includes("<work>")) {
  const work = prompt.match(/<work>\n([\s\S]*?)\n<\/work>/)?.[1] ?? "";
  await reply([
    JSON.stringify({
      score: work.includes("cache") ? 0.9 : 0.5,
      points: [{ point: "The first point", met: "partly", comment: "Say more." }],
      findings: [
        { error_type: "missed-edge-case", detail: `Nothing on the unusual cases in "${work}"` },
      ],
      feedback: "Think about **the unusual cases**.",
      // Explained aloud, it's marked for clarity too.
      ...(prompt.includes("explained this aloud")
        ? { clarity: { score: 0.75, feedback: "Say the cost **before** the details." } }
        : {}),
    }),
  ]);
  process.exit(0);
}
if (prompt.includes("flagged this card as wrong, saying")) {
  await reply([
    JSON.stringify({
      verdict: "wrong",
      explanation: "The fake grader agrees it's wrong.",
      fix: { answer: "A corrected answer.", explanation: null },
    }),
  ]);
  process.exit(0);
}
if (prompt.includes("Check this card for mistakes.")) {
  await reply([JSON.stringify({ verdict: "correct", explanation: "It's right." })]);
  process.exit(0);
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
  "divide it by one": {
    status: "edit",
    edits: [
      { find: "return len(data.splitlines())", replace: "return len(data.splitlines()) / 1‸" },
    ],
    summary: "divided it by one",
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
