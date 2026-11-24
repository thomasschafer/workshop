// A stand-in for the edit and discussion models, so end-to-end tests make no real model calls.
// It reads the prompt on stdin and replies to the utterances the tests use, in the shape of
// Claude Code's stream-json output.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** The lines of the brief in a prompt, as `- Topic: what it says`. */
function briefLines(prompt) {
  const brief = prompt.match(/<brief>\n([\s\S]*?)\n<\/brief>/)?.[1] ?? "";
  return brief.split("\n").filter((line) => line.startsWith("- "));
}

/** The words of five letters or more in some text, to match questions with the brief by. */
function words(text) {
  return new Set((text.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((w) => w !== "which"));
}

/** What the learner has asked, or said, in the prompt's transcript and conversation. */
function learnerSaid(prompt) {
  return (prompt.match(/^Learner: .*$/gm) ?? []).map((line) => line.replace(/^Learner: /, ""));
}

/**
 * An answer to the learner's last question from the brief: the line of it sharing the most
 * words with the question, or, if none does, a detail settled for the rest of the session.
 */
function answerFromBrief(prompt) {
  const said = learnerSaid(prompt);
  const question = said[said.length - 1] ?? "";
  const asked = words(question);
  let best = null;
  let most = 0;
  for (const line of briefLines(prompt)) {
    const shared = [...words(line)].filter((w) => asked.has(w)).length;
    if (shared > most) [best, most] = [line, shared];
  }
  if (best) return { answer: best.replace(/^- /, ""), settled: null };
  return { answer: "No, it doesn't.", settled: `It doesn't: "${question}"` };
}

// The coach of a design session, making up a brief for a prompt without one. Its peak is drawn
// afresh each time, so a test can tell whether the brief was kept or made again.
if (prompt.includes("Write the brief for this design question.")) {
  const peak = 1000 + Math.floor(Math.random() * 9000);
  await reply([
    `- Who uses it: other teams' services, through an API.\n- Peak: ${peak} requests a second, from 300 clients.\n- Latency: a decision within 5 ms.\n- Out of scope: billing.`,
  ]);
  process.exit(0);
}

// The coach of a design session, answering the learner's question from the brief.
if (prompt.includes("Answer their last question.")) {
  await reply([JSON.stringify(answerFromBrief(prompt))]);
  process.exit(0);
}

// The coach of a design session, asking follow-up questions about the stage the learner's at.
if (prompt.includes("Ask one or two follow-up questions about this stage.")) {
  const stage = prompt.match(/They're at the stage "([^"]+)"/)?.[1] ?? "?";
  const conversation = prompt.match(/<conversation>\n([\s\S]*?)<\/conversation>/)?.[1] ?? "";
  const answered = conversation.includes("Learner: ");
  await reply([
    answered
      ? "And what happens to that when traffic grows tenfold?"
      : `At ${stage}: what have you assumed here that might not hold?`,
  ]);
  process.exit(0);
}

// The examiner of a timed round of a design prompt, answering from its brief.
if (prompt.includes("Reply to their last message as the examiner.") && prompt.includes("<brief>")) {
  await reply([JSON.stringify(answerFromBrief(prompt))]);
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

// The tutor, asking a follow-up question on a card about what the learner said last. Told the
// tutor is away, it can't be reached the first time, as when no model can be, and is the next.
if (prompt.includes("Ask follow-up question")) {
  const [, number, limit] = prompt.match(/Ask follow-up question (\d+) of (\d+)/) ?? [];
  const said = (prompt.match(/^Learner(?: \(aloud\))?: .*$/gm) ?? []).map((line) =>
    line.replace(/^Learner(?: \(aloud\))?: /, ""),
  );
  const last = said[said.length - 1] ?? "";
  // Calls run in a directory of the home's own, so the home starts without the mark.
  const away = join(process.cwd(), "tutor-was-away");
  if (last.includes("tutor is away") && !existsSync(away)) {
    writeFileSync(away, "");
    process.stderr.write("The fake tutor can't be reached.\n");
    process.exit(1);
  }
  await reply([`Question ${number} of ${limit}: why is it that "${last}"?`]);
  process.exit(0);
}

// The grader, marking a card's follow-ups: each reply that doesn't say "because" is shallow.
if (prompt.includes("follow-up questions a tutor asked")) {
  const work = prompt.match(/<work>\n([\s\S]*?)\n<\/work>/)?.[1] ?? "";
  const replies = (work.match(/^Learner(?: \(aloud\))?: .*$/gm) ?? []).slice(1);
  const shallow = replies.filter((line) => !line.includes("because"));
  await reply([
    JSON.stringify({
      score: shallow.length === 0 ? 0.9 : 0.6,
      points: [
        {
          point: "Answers each follow-up question soundly",
          met: shallow.length === 0 ? "yes" : "partly",
          comment: "",
        },
      ],
      findings: shallow.map((line) => ({
        error_type: "concept-gap",
        detail: `Shallow: ${line.replace(/^Learner(?: \(aloud\))?: /, "")}`,
      })),
      feedback: "Say **why** each time.",
      ...(prompt.includes("explained this aloud")
        ? { clarity: { score: 0.7, feedback: "Lead with the reason." } }
        : {}),
    }),
  ]);
  process.exit(0);
}

/** What the learner found out of the brief in a prompt, by asking, and what they missed. */
function questioning(prompt) {
  const asked = new Set(learnerSaid(prompt).flatMap((said) => [...words(said)]));
  const found = [];
  const missed = [];
  for (const line of briefLines(prompt)) {
    const topic = line.replace(/^- /, "").split(":")[0] ?? line;
    ([...words(line)].some((w) => asked.has(w)) ? found : missed).push(topic);
  }
  return { found, missed, assumed: [] };
}

// The grader, marking a review of a change against its planted defects: a defect is found by a
// comment on a line it covers, and a comment saying "nothing" is a false alarm.
if (prompt.includes("<change>") && prompt.includes("<work>")) {
  const work = prompt.match(/<work>\n([\s\S]*?)\n<\/work>/)?.[1] ?? "";
  const lines = [...work.matchAll(/line (\d+)(?! of the old)/g)].map((m) => Number(m[1]));
  const points = (prompt.match(/<rubric>\n([\s\S]*?)<\/rubric>/)?.[1] ?? "")
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const [, start, end] = line.match(/:(\d+)(?:-(\d+))?\)$/) ?? [];
      const from = Number(start);
      const to = Number(end ?? start);
      const found = lines.some((n) => n >= from && n <= to);
      return { point: line.slice(2), met: found ? "yes" : "no", comment: found ? "Found it." : "" };
    });
  await reply([
    JSON.stringify({
      score: 1,
      points,
      findings: work.includes("nothing")
        ? [{ error_type: "misread", detail: "Said a line was wrong that's right" }]
        : [],
      feedback: "Look at what the change **leaves out** as well as what it adds.",
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
      // With a brief, what the learner asked is marked too: each topic of the brief that no
      // question of theirs shares a word with is missed.
      ...(prompt.includes("<brief>") ? { questioning: questioning(prompt) } : {}),
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
  // Told the coach is away, it can't be reached the first time, and is the next.
  const away = join(process.cwd(), "coach-was-away");
  if (question.includes("coach is away") && !existsSync(away)) {
    writeFileSync(away, "");
    process.stderr.write("The fake coach can't be reached.\n");
    process.exit(1);
  }
  if (question.includes("my notes")) {
    const notes = prompt.match(/<notes>\n([\s\S]*?)\n<\/notes>/)?.[1];
    await reply([notes ? `Your notes say "${notes}".` : "You have no notes."]);
  } else if (question.includes("slowly")) {
    // Slow enough to lose the connection part-way through.
    await reply(["Slowly, ", "step by step, ", "to the end."], 1500);
  } else if (question.includes("format")) {
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
