import { useEffect, useRef } from "preact/hooks";
import type { DayMeta, Problem } from "../api";

interface Props {
  problem: Problem | null;
  error: string | null;
  loading: boolean;
  meta: DayMeta;
  onMeta: (meta: DayMeta) => void;
  onRefresh: () => void;
}

export function ProblemView({ problem, error, loading, meta, onMeta, onRefresh }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const pre of root.querySelectorAll<HTMLElement>("pre[data-block]")) {
      pre.classList.toggle("is-sample", Number(pre.dataset.block) === meta.sample_block);
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
    const pre = target.closest<HTMLElement>("pre[data-block]");
    if (pre) {
      const index = Number(pre.dataset.block);
      onMeta({ ...meta, sample_block: index, sample_input: problem.blocks[index] ?? null });
      return;
    }
    const code = target.closest<HTMLElement>("code[data-code]");
    const part = target.closest<HTMLElement>("[data-part]");
    if (code && part) {
      const partIndex = Number(part.dataset.part);
      const answers: [string | null, string | null] = [...meta.sample_answers];
      const text = code.textContent?.trim() ?? null;
      answers[partIndex] = answers[partIndex] === text ? null : text;
      onMeta({ ...meta, sample_answers: answers });
    }
  };

  return (
    <div class="pane problem" ref={ref}>
      <p class="hint">
        Tap a code block to use it as the sample input, and tap the sample's answer to mark it as
        expected.
      </p>
      <div class="sample-summary">
        <span>
          Sample: {meta.sample_block === null ? "none" : `block ${meta.sample_block + 1}`}
        </span>
        {problem.parts_html.map((_, i) => (
          <span key={i}>
            Part {i + 1} expects: {meta.sample_answers[i] ?? "–"}
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
