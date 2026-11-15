import type { Diagnostics, LanguageServerStatus, LanguageServerUnavailable } from "../editor";
import { headline } from "../problems";
import type { SaveStatus } from "../saver";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the language server has found, in words: "2 errors, 1 warning", or "no errors". */
export function describeCounts({ errors, warnings, others }: Diagnostics): string {
  const parts: string[] = [];
  if (errors) parts.push(plural(errors, "error"));
  if (warnings) parts.push(plural(warnings, "warning"));
  // Hints are only worth a mention when there's nothing worse.
  if (parts.length === 0 && others) parts.push(plural(others, "hint"));
  return parts.length > 0 ? parts.join(", ") : "no errors";
}

/**
 * The line above the code: the language server's checks, saving, and what there is to say of
 * where the cursor is, which is the problem there if there is one, and otherwise its type. If
 * the language server's been given up on, a quiet note below it says why.
 */
export function StatusLine({
  checks,
  unavailable,
  onRetry,
  serverError,
  diagnostics,
  saveStatus,
  hover,
  showProblem,
  onProblems,
}: {
  /** The language server's status, or null if the language has none. */
  checks: LanguageServerStatus | null;
  /** Why the language server's been given up on, if it has. */
  unavailable: LanguageServerUnavailable | null;
  /** Tries the language server again, once it's been given up on. */
  onRetry: () => void;
  /** Whether the language server has reported an error of its own, shown with the problems. */
  serverError: boolean;
  diagnostics: Diagnostics;
  saveStatus: SaveStatus;
  hover: string | null;
  /** Whether the problem under the cursor shows here, rather than in Helix's status line. */
  showProblem: boolean;
  /** Opens the list of problems, with their whole messages. */
  onProblems: () => void;
}) {
  const saving =
    saveStatus === "error"
      ? "not saved"
      : saveStatus !== "saved" && saveStatus !== "conflict"
        ? "saving"
        : null;
  const any = diagnostics.errors + diagnostics.warnings + diagnostics.others > 0;
  const problem = showProblem ? diagnostics.atCursor : null;
  return (
    <>
      <div class="status-line">
        <span class="status-checks">
          {checks === null ? null : checks === "unavailable" ? (
            "no checks"
          ) : checks !== "ready" ? (
            "starting checks"
          ) : any ? (
            <button type="button" class="status-count" onClick={onProblems}>
              {describeCounts(diagnostics)}
            </button>
          ) : (
            describeCounts(diagnostics)
          )}
          {checks === "ready" && serverError ? (
            <>
              {" · "}
              <button type="button" class="status-count severity-error" onClick={onProblems}>
                server error
              </button>
            </>
          ) : null}
          {checks !== null && saving ? " · " : null}
          {saving}
        </span>
        {problem ? (
          <button
            type="button"
            class={`status-problem severity-${problem.severity}`}
            title="Show the whole message"
            onClick={onProblems}
          >
            {headline(problem)}
          </button>
        ) : hover ? (
          <code class="hover">{hover}</code>
        ) : null}
      </div>
      {checks === "unavailable" && unavailable ? (
        <UnavailableNote unavailable={unavailable} onRetry={onRetry} />
      ) : null}
    </>
  );
}

/**
 * Says completions and checks are off, and why, without getting in the way: the code can still
 * be edited, run and submitted without the language server.
 */
function UnavailableNote({
  unavailable,
  onRetry,
}: {
  unavailable: LanguageServerUnavailable;
  onRetry: () => void;
}) {
  return (
    <p class="lsp-unavailable" role="status">
      Completions and error checks are unavailable: {unavailable.reason}.
      {unavailable.help ? ` ${unavailable.help}` : null}{" "}
      <button type="button" class="text-button" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}
