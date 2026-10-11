import type { RunResult, SubmitOutcome } from "../api";

export type InputKind = "sample" | "real";

export interface RunState {
  running: InputKind | null;
  last: { input: InputKind; result: RunResult } | null;
  error: string | null;
  submitting: boolean;
  submitted: SubmitOutcome | null;
  confirmSubmit: boolean;
}

export const initialRunState: RunState = {
  running: null,
  last: null,
  error: null,
  submitting: false,
  submitted: null,
  confirmSubmit: false,
};

interface Props {
  state: RunState;
  /** 1 or 2, or null once both stars are earned. */
  part: number | null;
  expected: string | null;
  onRun: (input: InputKind) => void;
  onCancel: () => void;
  onAskSubmit: () => void;
  onSubmit: (answer: string) => void;
  onDismissSubmit: () => void;
}

export function describeEnding(result: RunResult): string {
  const seconds = (result.duration_ms / 1000).toFixed(1);
  const phase = result.phase === "build" ? "Build" : "Run";
  switch (result.ending.status) {
    case "exited":
      return result.ending.code === 0
        ? `${phase} finished in ${seconds}s`
        : `${phase} failed (exit ${result.ending.code ?? "signal"}) after ${seconds}s`;
    case "timed_out":
      return `${phase} timed out after ${seconds}s`;
    case "cancelled":
      return `${phase} cancelled`;
  }
}

function describeSubmission(outcome: SubmitOutcome): string {
  switch (outcome.result) {
    case "correct":
      return "Correct! ★";
    case "incorrect":
      return outcome.hint ? `Not right: your answer is ${outcome.hint}.` : "Not the right answer.";
    default:
      return outcome.message;
  }
}

export function RunSheet({
  state,
  part,
  expected,
  onRun,
  onCancel,
  onAskSubmit,
  onSubmit,
  onDismissSubmit,
}: Props) {
  const last = state.last;
  const partIndex = part === null ? null : part - 1;
  const answer = last && partIndex !== null ? (last.result.answers[partIndex] ?? null) : null;
  const sampleMatches =
    last?.input === "sample" && expected !== null && answer !== null && answer === expected;
  const canSubmit =
    last?.input === "real" && answer !== null && part !== null && last.result.phase === "run";

  return (
    <div class="run">
      <div class="run-buttons">
        <button
          type="button"
          class="pill"
          disabled={state.running !== null}
          onClick={() => onRun("sample")}
        >
          {state.running === "sample" ? "Running…" : "Run sample"}
        </button>
        <button
          type="button"
          class={`pill ${sampleMatches ? "primary" : ""}`}
          disabled={state.running !== null}
          onClick={() => onRun("real")}
        >
          {state.running === "real" ? "Running…" : "Run real input"}
        </button>
        {state.running ? (
          <button type="button" class="pill" onClick={onCancel}>
            Stop
          </button>
        ) : null}
      </div>

      {state.error ? <p class="error-text">{state.error}</p> : null}

      {last ? (
        <div class="run-result">
          <p class="muted">
            {last.input === "sample" ? "Sample" : "Real input"}: {describeEnding(last.result)}
          </p>
          {last.result.answers.length > 0 ? (
            <ol class="answers">
              {last.result.answers.slice(0, 2).map((a, i) => (
                <li key={i}>
                  Part {i + 1}: <code>{a}</code>
                  {last.input === "sample" && i === partIndex && expected !== null
                    ? a === expected
                      ? " ✓"
                      : ` ✗ (expected ${expected})`
                    : null}
                </li>
              ))}
            </ol>
          ) : null}
          {last.input === "sample" && expected === null && part !== null ? (
            <p class="muted">Tap the sample's answer in the puzzle to check it automatically.</p>
          ) : null}
          {sampleMatches ? (
            <p>The sample passes. Run on the real input to get your answer.</p>
          ) : null}
          {last.result.stderr.trim() ? <pre class="output">{last.result.stderr}</pre> : null}
          {last.result.answers.length > 2 ? <pre class="output">{last.result.stdout}</pre> : null}
        </div>
      ) : (
        <p class="muted">Line 1 of your program's output is the part 1 answer; line 2 is part 2.</p>
      )}

      {canSubmit && answer !== null && part !== null ? (
        state.confirmSubmit ? (
          <div class="confirm">
            <p>
              Submit <code>{answer}</code> for part {part}?
            </p>
            <div class="run-buttons">
              <button type="button" class="pill" onClick={onDismissSubmit}>
                Cancel
              </button>
              <button
                type="button"
                class="pill primary"
                disabled={state.submitting}
                onClick={() => onSubmit(answer)}
              >
                {state.submitting ? "Submitting…" : "Submit"}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" class="pill primary wide" onClick={onAskSubmit}>
            Submit part {part}: {answer}
          </button>
        )
      ) : null}

      {state.submitted ? <p class="submitted">{describeSubmission(state.submitted)}</p> : null}
      {part === null ? <p class="muted">Both stars earned for this day. ★★</p> : null}
    </div>
  );
}
