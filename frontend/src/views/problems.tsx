import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Problem } from "../problems";
import { Modal } from "./modal";

/**
 * Every problem the language server has found, each with its whole message, which can run to
 * dozens of lines: along the bottom, or over the whole screen for room to read. Choosing one
 * goes to it in the code.
 */
export function ProblemsSheet({
  problems,
  current,
  onGoto,
  onClose,
}: {
  problems: readonly Problem[];
  /** The problem the cursor is on, which the list starts at. */
  current: Problem | null;
  onGoto: (problem: Problem) => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const currentRow = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => currentRow.current?.scrollIntoView({ block: "start" }), []);
  const isCurrent = (p: Problem) =>
    current !== null &&
    p.from === current.from &&
    p.to === current.to &&
    p.message === current.message;
  return (
    <Modal
      title={problems.length === 1 ? "1 problem" : `${problems.length} problems`}
      onClose={onClose}
      shape={expanded ? "full" : "sheet"}
    >
      <button type="button" class="text-button" onClick={() => setExpanded(!expanded)}>
        {expanded ? "Show less of the screen" : "Use the whole screen"}
      </button>
      {problems.length === 0 ? <p class="muted">The language server has no complaints.</p> : null}
      <ul class="problems">
        {problems.map((problem) => (
          <li
            key={`${problem.from}-${problem.to}-${problem.message}`}
            ref={isCurrent(problem) ? currentRow : null}
          >
            <button
              type="button"
              class={`problem-row ${isCurrent(problem) ? "current" : ""}`}
              onClick={() => onGoto(problem)}
            >
              <span class={`problem-where severity-${problem.severity}`}>
                {problem.severity}, line {problem.line}
              </span>
              <span class="problem-message">{problem.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
