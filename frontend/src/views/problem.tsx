import { useEffect, useRef } from "preact/hooks";
import type { DayMeta, Problem } from "../api";
import { type PartIndex, toggleAnswer, toggleSample } from "../samples";

interface Props {
  problem: Problem | null;
  error: string | null;
  loading: boolean;
  meta: DayMeta;
  onMeta: (meta: DayMeta) => void;
  onRefresh: () => void;
}

function describeSample(meta: DayMeta, part: PartIndex): string {
  const block = meta.sample_blocks[part];
  if (block !== null) return `sample block ${block + 1}`;
  if (part === 1 && meta.sample_inputs[0] !== null) return "part 1's sample";
  return "no sample";
}

export function ProblemView({ problem, error, loading, meta, onMeta, onRefresh }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const pre of root.querySelectorAll<HTMLElement>("pre[data-block]")) {
      const block = Number(pre.dataset.block);
      pre.classList.toggle("is-sample", meta.sample_blocks.includes(block));
    }
    for (const part of root.querySelectorAll<HTMLElement>("[data-part]")) {
      const answer = meta.sample_answers[Number(part.dataset.part)];
      for (const code of part.querySelectorAll<HTMLElement>("code[data-code]")) {
        code.classList.toggle("is-answer", answer !== null && code.textContent?.trim() === answer);
      }
    }
  });

  if (!problem) {
    return (
      <div class="pane problem">
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
    const part: PartIndex | null = (() => {
      const index = Number(target.closest<HTMLElement>("[data-part]")?.dataset.part);
      return index === 0 || index === 1 ? index : null;
    })();
    if (part === null) return;
    const pre = target.closest<HTMLElement>("pre[data-block]");
    if (pre) {
      onMeta(toggleSample(meta, problem, part, Number(pre.dataset.block)));
      return;
    }
    const code = target.closest<HTMLElement>("code[data-code]")?.textContent?.trim();
    if (code) {
      onMeta(toggleAnswer(meta, part, code));
    }
  };

  return (
    <div class="pane problem" ref={ref}>
      <p class="hint">
        Tap a code block to use it as that part's sample input, and tap the sample's answer to mark
        it as expected.
      </p>
      <div class="sample-summary">
        {problem.parts_html.slice(0, 2).map((_, i) => (
          <span key={i}>
            Part {i + 1}: {describeSample(meta, i === 0 ? 0 : 1)}, expects{" "}
            {meta.sample_answers[i] ?? "–"}
          </span>
        ))}
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
      <button type="button" class="text-button" onClick={onRefresh} disabled={loading}>
        {loading ? "Refreshing…" : "Refresh puzzle"}
      </button>
    </div>
  );
}
