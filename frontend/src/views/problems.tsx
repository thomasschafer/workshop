import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import type { Problem } from "../problems";
import { Modal } from "./modal";

/** The language server itself, for when it's gone wrong. */
export interface ServerHelp {
  /** The last error the server reported, if there's one to show. */
  error: string | null;
  onDismiss: () => void;
  onRestart: () => Promise<unknown>;
}

/**
 * Every problem the language server has found, each with its whole message, which can run to
 * dozens of lines: along the bottom, or over the whole screen for room to read. Choosing one
 * goes to it in the code. With `server`, any error the server itself reported comes first, and
 * the server can be restarted.
 */
export function ProblemsSheet({
  problems,
  current,
  server,
  backend,
  onReconnectServer,
  onGoto,
  onClose,
}: {
  problems: readonly Problem[];
  /** The problem the cursor is on, which the list starts at. */
  current: Problem | null;
  server: ServerHelp | null;
  /** Where the language server is running, shown quietly for diagnostics. */
  backend?: "server" | "local" | undefined;
  /** Manually switches from sticky on-device LSP back to the server language server. */
  onReconnectServer?: (() => void) | undefined;
  onGoto: (problem: Problem) => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const restart = async (help: ServerHelp) => {
    setRestarting(true);
    setRestartError(null);
    try {
      await help.onRestart();
      onClose();
    } catch (error) {
      setRestartError(`Couldn't restart the language server: ${errorMessage(error)}`);
      setRestarting(false);
    }
  };
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
      {backend ? (
        <p class="muted small">
          Language server: {backend === "local" ? "on device (GHC 9.14 WASM)" : "on server"}
          {backend === "local" && onReconnectServer ? (
            <>
              {" · "}
              <button
                type="button"
                class="text-button inline"
                onClick={() => {
                  onReconnectServer();
                  onClose();
                }}
              >
                Reconnect to server
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {server?.error ? (
        <div class="problem-row server-error">
          <span class="problem-where severity-error">the language server</span>
          <span class="problem-message">{server.error}</span>
          <button
            type="button"
            class="text-button inline server-error-dismiss"
            onClick={server.onDismiss}
          >
            Dismiss
          </button>
        </div>
      ) : problems.length === 0 ? (
        <p class="muted">The language server has no complaints.</p>
      ) : null}
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
      {server ? (
        <button
          type="button"
          class="text-button"
          disabled={restarting}
          onClick={() => restart(server)}
        >
          {restarting ? "Restarting the language server…" : "Restart the language server"}
        </button>
      ) : null}
      {restartError ? <p class="severity-error">{restartError}</p> : null}
    </Modal>
  );
}
