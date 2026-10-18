import type { DayMeta, FoundSample, Problem } from "./api";

export type PartIndex = 0 | 1;

export const EMPTY_META: DayMeta = {
  sample_blocks: [null, null],
  sample_inputs: [null, null],
  sample_answers: [null, null],
  cursor: null,
};

/** The sample input a part runs against: its own, or part 1's if it has none. */
export function sampleInput(meta: DayMeta, part: PartIndex): string | null {
  return meta.sample_inputs[part] ?? (part === 1 ? meta.sample_inputs[0] : null);
}

/** Fills in each part's sample input and expected answer from the puzzle's likely candidates. */
export function withSuggestions(meta: DayMeta, problem: Problem): DayMeta {
  const blocks: [number | null, number | null] = [...meta.sample_blocks];
  const inputs: [string | null, string | null] = [...meta.sample_inputs];
  const answers: [string | null, string | null] = [...meta.sample_answers];
  let changed = false;
  for (const i of [0, 1] as const) {
    const block = problem.suggested_sample_blocks[i];
    if (blocks[i] === null && block !== null && block !== undefined) {
      blocks[i] = block;
      inputs[i] = problem.blocks[block] ?? null;
      changed = true;
    }
    const answer = problem.suggested_sample_answers[i];
    if (answers[i] === null && answer) {
      answers[i] = answer;
      changed = true;
    }
  }
  return changed
    ? { ...meta, sample_blocks: blocks, sample_inputs: inputs, sample_answers: answers }
    : meta;
}

/** Whether a part's sample and answer are still the ones suggested from the page's structure. */
export function stillSuggested(meta: DayMeta, problem: Problem, part: PartIndex): boolean {
  const block = problem.suggested_sample_blocks[part] ?? null;
  const input = block === null ? null : (problem.blocks[block] ?? null);
  return (
    meta.sample_blocks[part] === block &&
    meta.sample_inputs[part] === input &&
    meta.sample_answers[part] === (problem.suggested_sample_answers[part] ?? null)
  );
}

/**
 * Whether a part's example is worth finding: it lacks a sample input or an expected answer, or,
 * when the suggestions from the page can't be relied on, it still has them.
 */
export function needsSample(
  meta: DayMeta,
  problem: Problem,
  part: PartIndex,
  distrustSuggestions: boolean,
): boolean {
  return (
    sampleInput(meta, part) === null ||
    meta.sample_answers[part] === null ||
    (distrustSuggestions && stillSuggested(meta, problem, part))
  );
}

const sameText = (a: string, b: string) =>
  a
    .trimEnd()
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n") ===
  b
    .trimEnd()
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");

/**
 * Fills in what a part still lacks from the example found for it, keeping anything the user
 * chose. With `replaceSuggestions`, what was only suggested from the page's structure is replaced
 * too. An input and an answer are only used together, so a part never checks one example's answer
 * against another's input.
 */
export function withFoundSample(
  meta: DayMeta,
  problem: Problem,
  part: PartIndex,
  found: FoundSample,
  replaceSuggestions: boolean,
): DayMeta {
  const blocks: [number | null, number | null] = [...meta.sample_blocks];
  const inputs: [string | null, string | null] = [...meta.sample_inputs];
  const answers: [string | null, string | null] = [...meta.sample_answers];
  if (replaceSuggestions && stillSuggested(meta, problem, part)) {
    blocks[part] = null;
    inputs[part] = null;
    answers[part] = null;
  }
  const own = inputs[part];
  const answer = answers[part];
  if (own !== null && !sameText(own, found.input)) return meta;
  if (answer !== null && answer !== found.answer) return meta;
  const partOne = inputs[0];
  // Part 2 keeps using part 1's input when the example is the same one.
  const inherits = part === 1 && partOne !== null && sameText(partOne, found.input);
  if (own === null && !inherits) {
    // Chosen as a code block when it is one, so it's marked in the puzzle.
    const block = problem.blocks.findIndex((b) => sameText(b, found.input));
    blocks[part] = block === -1 ? null : block;
    inputs[part] = block === -1 ? found.input : (problem.blocks[block] ?? null);
  }
  if (answer === null) answers[part] = found.answer;
  const changed =
    blocks[part] !== meta.sample_blocks[part] ||
    inputs[part] !== meta.sample_inputs[part] ||
    answers[part] !== meta.sample_answers[part];
  return changed
    ? { ...meta, sample_blocks: blocks, sample_inputs: inputs, sample_answers: answers }
    : meta;
}

/** The values in a sample, so one written inline, as "+1, -2", matches it written one per line. */
const values = (text: string) => text.split(/[\s,]+/).filter((v) => v !== "");

/** Whether `text`, such as inline code in the puzzle, is the sample written another way. */
export function sameValues(text: string, sample: string): boolean {
  const a = values(text);
  const b = values(sample);
  return a.length > 0 && a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A piece of inline code in the puzzle, in the order it appears. */
export interface PuzzleCode {
  text: string;
  emphasised: boolean;
  /** Whether it comes after the part's sample input in the puzzle. */
  afterSample: boolean;
}

/**
 * Which of a part's inline code is its expected answer, where the same value often appears more
 * than once: the emphasised one if the puzzle emphasises it, or else the first after the sample
 * input, which ends its worked example, or else the last.
 */
export function answerCode(codes: readonly PuzzleCode[], answer: string): number | null {
  const matches = codes.flatMap((c, i) => (c.text.trim() === answer ? [i] : []));
  const emphasised = matches.filter((i) => codes[i]?.emphasised);
  if (emphasised.length > 0) return emphasised.at(-1) ?? null;
  return matches.find((i) => codes[i]?.afterSample) ?? matches.at(-1) ?? null;
}

/** Makes `block` the part's sample, or clears it if it already was. */
export function toggleSample(
  meta: DayMeta,
  problem: Problem,
  part: PartIndex,
  block: number,
): DayMeta {
  const blocks: [number | null, number | null] = [...meta.sample_blocks];
  const inputs: [string | null, string | null] = [...meta.sample_inputs];
  const chosen = blocks[part] === block;
  blocks[part] = chosen ? null : block;
  inputs[part] = chosen ? null : (problem.blocks[block] ?? null);
  return { ...meta, sample_blocks: blocks, sample_inputs: inputs };
}

/** Makes `answer` the part's expected sample answer, or clears it if it already was. */
export function toggleAnswer(meta: DayMeta, part: PartIndex, answer: string): DayMeta {
  const answers: [string | null, string | null] = [...meta.sample_answers];
  answers[part] = answers[part] === answer ? null : answer;
  return { ...meta, sample_answers: answers };
}

/** Uses text typed or picked by the user as a part's sample input, rather than a code block. */
export function setSampleText(meta: DayMeta, part: PartIndex, text: string | null): DayMeta {
  const blocks: [number | null, number | null] = [...meta.sample_blocks];
  const inputs: [string | null, string | null] = [...meta.sample_inputs];
  blocks[part] = null;
  inputs[part] = text === null || text.trim() === "" ? null : text;
  return { ...meta, sample_blocks: blocks, sample_inputs: inputs };
}

export function setAnswer(meta: DayMeta, part: PartIndex, answer: string | null): DayMeta {
  const answers: [string | null, string | null] = [...meta.sample_answers];
  answers[part] = answer === null || answer.trim() === "" ? null : answer.trim();
  return { ...meta, sample_answers: answers };
}
