// What the language server has to say about the code: its errors, warnings and hints, as the
// editor keeps them.

import { forEachDiagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";

export type Severity = "error" | "warning" | "info" | "hint";

/** Something the language server has to say about a stretch of the code. */
export interface Problem {
  readonly from: number;
  readonly to: number;
  /** The line it starts on, counting from 1. */
  readonly line: number;
  readonly severity: Severity;
  readonly message: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** Every problem in the code, in the order they come in it. */
export function problemsIn(state: EditorState): Problem[] {
  const problems: Problem[] = [];
  forEachDiagnostic(state, (d, from, to) => {
    problems.push({
      from,
      to,
      line: state.doc.lineAt(Math.min(from, state.doc.length)).number,
      severity: d.severity,
      message: d.message,
    });
  });
  return problems.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** The most serious problem that `pos` is on, and of those the one that starts last. */
export function problemAt(problems: readonly Problem[], pos: number): Problem | null {
  let best: Problem | null = null;
  for (const problem of problems) {
    if (pos < problem.from || pos > problem.to) continue;
    if (
      best === null ||
      SEVERITY_ORDER[problem.severity] < SEVERITY_ORDER[best.severity] ||
      (problem.severity === best.severity && problem.from >= best.from)
    ) {
      best = problem;
    }
  }
  return best;
}

/** A problem's first line, which is all there's room for beside the code. */
export function headline(problem: Problem): string {
  return problem.message.split("\n")[0]?.trim() ?? "";
}
