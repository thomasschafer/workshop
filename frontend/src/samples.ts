import type { DayMeta, Problem } from "./api";

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
