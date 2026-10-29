import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, type DayMeta, type Problem, type Puzzle } from "../api";
import {
  answerCode,
  inheritsPartOne,
  type PartIndex,
  sameValues,
  sampleInput,
  setAnswer,
  setSampleText,
  toggleSample,
} from "../samples";

interface Props {
  puzzle: Puzzle;
  problem: Problem | null;
  error: string | null;
  loading: boolean;
  meta: DayMeta;
  onMeta: (meta: DayMeta) => void;
  onRefresh: () => void;
  /** Clears progress, for puzzles that can be played again, such as the practice puzzle. */
  onStartAgain: (() => void) | null;
  /** Parts whose example is being looked for. */
  findingSamples: readonly PartIndex[];
  /** Kept in the page while another tab is shown, so it's where the user left it on coming back. */
  hidden: boolean;
}

/** Code the user tapped in the puzzle, waiting for them to say what it is. */
interface Picked {
  part: PartIndex;
  text: string;
  block: number | null;
}

function describeSample(meta: DayMeta, part: PartIndex, finding: boolean): string {
  const block = meta.sample_blocks[part];
  if (block !== null) return `code block ${block + 1}`;
  const text = meta.sample_inputs[part];
  if (text !== null) {
    const lines = text.trimEnd().split("\n").length;
    return lines === 1 ? `"${text.trim()}"` : `${lines} lines`;
  }
  if (part === 1 && sampleInput(meta, 1) !== null) return "same as part 1";
  return finding ? "looking for the example…" : "none chosen";
}

export function ProblemView({
  puzzle,
  problem,
  error,
  loading,
  meta,
  onMeta,
  onRefresh,
  onStartAgain,
  findingSamples,
  hidden,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [editing, setEditing] = useState<PartIndex | null>(null);
  // Browsers may forget how far an element was scrolled while it's not displayed.
  const scrollTop = useRef(0);

  useEffect(() => {
    scrollTop.current = 0;
  }, [puzzle.year, puzzle.day]);

  useLayoutEffect(() => {
    if (!hidden && ref.current) ref.current.scrollTop = scrollTop.current;
  }, [hidden]);

  const pane = {
    ref,
    class: `pane problem ${hidden ? "hidden" : ""}`,
    onScroll: () => {
      if (!hidden && ref.current) scrollTop.current = ref.current.scrollTop;
    },
  };

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const pre of root.querySelectorAll<HTMLElement>("pre[data-block]")) {
      const block = Number(pre.dataset.block);
      pre.classList.toggle("is-sample", meta.sample_blocks.includes(block));
    }
    for (const part of root.querySelectorAll<HTMLElement>("[data-part]")) {
      const index = Number(part.dataset.part) === 0 ? 0 : 1;
      const answer = meta.sample_answers[index];
      const input = meta.sample_blocks[index] === null ? meta.sample_inputs[index] : null;
      const codes = [...part.querySelectorAll<HTMLElement>("code[data-code]")];
      for (const code of codes) {
        code.classList.toggle(
          "is-sample",
          input !== null && sameValues(code.textContent ?? "", input),
        );
      }
      const sample = part.querySelector(".is-sample");
      const chosen =
        answer === null
          ? null
          : answerCode(
              codes.map((code) => ({
                text: code.textContent ?? "",
                emphasised: code.closest("em") !== null || code.querySelector("em") !== null,
                afterSample:
                  sample !== null &&
                  (sample.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
              })),
              answer,
            );
      codes.forEach((code, i) => {
        code.classList.toggle("is-answer", i === chosen);
      });
    }
  });

  if (!problem) {
    return (
      <div {...pane}>
        {loading ? <p class="muted">Fetching the puzzle…</p> : null}
        {error ? <p class="error-text">{error}</p> : null}
        {!loading ? (
          <button type="button" class="text-button" onClick={onRefresh}>
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  const onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("a")) return;
    const index = Number(target.closest<HTMLElement>("[data-part]")?.dataset.part);
    if (index !== 0 && index !== 1) return;
    const pre = target.closest<HTMLElement>("pre[data-block]");
    if (pre) {
      const block = Number(pre.dataset.block);
      setPicked({ part: index, block, text: problem.blocks[block] ?? "" });
      return;
    }
    const code = target.closest<HTMLElement>("code[data-code]")?.textContent;
    if (code?.trim()) {
      setPicked({ part: index, block: null, text: code });
    }
  };

  const useAsSample = (choice: Picked) => {
    onMeta(
      choice.block === null
        ? setSampleText(meta, choice.part, choice.text)
        : toggleSample(setSampleText(meta, choice.part, null), problem, choice.part, choice.block),
    );
    setPicked(null);
  };

  return (
    <div {...pane}>
      <div class="sample-summary">
        {problem.parts_html.slice(0, 2).map((_, i) => {
          const part: PartIndex = i === 0 ? 0 : 1;
          return (
            <div key={i} class="sample-row">
              <span>
                Part {i + 1} sample: {describeSample(meta, part, findingSamples.includes(part))} ·
                expects {meta.sample_answers[part] ?? "–"}
              </span>
              <button
                type="button"
                class="text-button"
                onClick={() => setEditing(editing === part ? null : part)}
              >
                {editing === part ? "Done" : "Edit"}
              </button>
              {editing === part ? <SampleEditor meta={meta} part={part} onMeta={onMeta} /> : null}
            </div>
          );
        })}
      </div>

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: tapping puzzle code is a touch shortcut */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: tapping puzzle code is a touch shortcut */}
      <div onClick={onClick}>
        {problem.parts_html.map((html, i) => (
          <article key={i} data-part={i} class="part">
            {/* The server rebuilds puzzle HTML from an allowlist of elements and attributes. */}
            <div dangerouslySetInnerHTML={{ __html: html }} />
            {problem.answers[i] ? (
              <p class="accepted">
                Your answer was <code>{problem.answers[i]}</code> ★
              </p>
            ) : null}
          </article>
        ))}
      </div>

      <PuzzleInput puzzle={puzzle} />

      {onStartAgain === null ? (
        <button type="button" class="text-button" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh puzzle"}
        </button>
      ) : problem.stars > 0 ? (
        <button type="button" class="text-button" onClick={onStartAgain}>
          Start again
        </button>
      ) : null}

      {picked ? (
        <div class="chooser">
          <code class="chooser-preview">{preview(picked.text)}</code>
          <button type="button" class="pill" onClick={() => useAsSample(picked)}>
            Part {picked.part + 1} sample input
          </button>
          {picked.block === null ? (
            <button
              type="button"
              class="pill"
              onClick={() => {
                onMeta(setAnswer(meta, picked.part, picked.text));
                setPicked(null);
              }}
            >
              Part {picked.part + 1} expected answer
            </button>
          ) : null}
          <button type="button" class="text-button" onClick={() => setPicked(null)}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

function preview(text: string): string {
  const lines = text.trimEnd().split("\n");
  const first = lines.slice(0, 3).join("\n");
  return lines.length > 3 ? `${first}\n… ${lines.length - 3} more lines` : first;
}

function SampleEditor({
  meta,
  part,
  onMeta,
}: {
  meta: DayMeta;
  part: PartIndex;
  onMeta: (meta: DayMeta) => void;
}) {
  const inherited = part === 1 && inheritsPartOne(meta) ? meta.sample_inputs[0] : null;
  return (
    <div class="sample-editor">
      <label>
        Sample input{inherited !== null ? " (using part 1's until you change it)" : ""}
        <textarea
          rows={5}
          value={meta.sample_inputs[part] ?? inherited ?? ""}
          onInput={(e) =>
            onMeta(setSampleText(meta, part, (e.target as HTMLTextAreaElement).value))
          }
          spellcheck={false}
          autocapitalize="off"
        />
      </label>
      <label>
        Expected answer
        <input
          value={meta.sample_answers[part] ?? ""}
          onInput={(e) => onMeta(setAnswer(meta, part, (e.target as HTMLInputElement).value))}
          spellcheck={false}
          autocapitalize="off"
        />
      </label>
    </div>
  );
}

function PuzzleInput({ puzzle }: { puzzle: Puzzle }) {
  const [state, setState] = useState<
    | { kind: "hidden" }
    | { kind: "loading" }
    | { kind: "shown"; text: string; lines: number }
    | { kind: "error"; message: string }
  >({ kind: "hidden" });

  useEffect(() => setState({ kind: "hidden" }), [puzzle.year, puzzle.day]);

  const show = async () => {
    setState({ kind: "loading" });
    try {
      const input = await api.input(puzzle);
      setState({ kind: "shown", text: input.text, lines: input.lines });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <section class="puzzle-input">
      {state.kind === "shown" ? (
        <>
          <div class="sample-row">
            <span class="muted">
              Your puzzle input: {state.lines} line{state.lines === 1 ? "" : "s"}
            </span>
            <button type="button" class="text-button" onClick={() => setState({ kind: "hidden" })}>
              Hide
            </button>
          </div>
          <pre class="input-text">{state.text}</pre>
        </>
      ) : (
        <button
          type="button"
          class="text-button"
          onClick={() => void show()}
          disabled={state.kind === "loading"}
        >
          {state.kind === "loading" ? "Fetching your input…" : "Show your puzzle input"}
        </button>
      )}
      {state.kind === "error" ? <p class="error-text">{state.message}</p> : null}
    </section>
  );
}
