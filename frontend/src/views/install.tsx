import { useEffect, useState } from "preact/hooks";
import type { InstallStatus, LastInstall, ProgramNeeds } from "../api";
import { errorMessage } from "../errors";
import { useElapsed } from "../hooks/useElapsed";

/** How often to check on an install, for its progress. */
export const INSTALL_PROGRESS_MS = 1000;

/** An install under way: how long it's taken, what the installer last said, and Cancel. */
export function InstallProgress({
  label,
  since,
  progress,
  onCancel,
}: {
  label: string;
  /** When this page started it, from `performance.now()`; null if it was started elsewhere. */
  since: number | null;
  progress: string | null;
  onCancel: () => void;
}) {
  const elapsed = useElapsed(since);
  return (
    <div class="install-progress">
      <span>
        {label} {elapsed === null ? null : <span class="elapsed">{elapsed.toFixed(0)}s</span>}
        <button type="button" class="text-button" onClick={onCancel}>
          Cancel
        </button>
      </span>
      {progress ? <code class="progress-line">{progress}</code> : null}
    </div>
  );
}

/** The output of the last install, shown on request. */
export function LastInstallLog({ last }: { last: LastInstall }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <p class="small">
        <button type="button" class="text-button" onClick={() => setShown(!shown)}>
          {shown ? "Hide" : "Show"} the last install's output
        </button>
      </p>
      {shown ? <pre class="install-log">{last.log.join("\n")}</pre> : null}
    </>
  );
}

/**
 * What a language's programs are missing, and installing them with mise where Workshop knows
 * how, as setup does for the solutions folder and the Coding track for its own code. Follows an
 * install's progress, including one started elsewhere, such as in another tab.
 */
export function ProgramsInstall({
  name,
  needs,
  miseInstalled,
  problem,
  install,
  scope,
  onInstall,
  onCancel,
  onRefresh,
}: {
  /** The language's name. */
  name: string;
  needs: ProgramNeeds;
  miseInstalled: boolean;
  /** Why the language's mise config couldn't be read, if it couldn't. */
  problem: string | null;
  install: InstallStatus;
  /** What the programs are installed for, such as "your solutions folder". */
  scope: string;
  /** Installs them, once the install has finished. */
  onInstall: () => Promise<unknown>;
  onCancel: () => void;
  /** Checks again what's installed, and on the install. */
  onRefresh: () => void;
}) {
  const [installingSince, setInstallingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const installing = installingSince !== null || install.installing;
  const { missing, missing_language_server: missingServer } = needs;

  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(onRefresh, INSTALL_PROGRESS_MS);
    return () => clearInterval(timer);
  }, [installing]);

  const start = async () => {
    setInstallingSince(performance.now());
    setError(null);
    try {
      await onInstall();
    } catch (e) {
      setError(errorMessage(e));
      onRefresh();
    } finally {
      setInstallingSince(null);
    }
  };

  return (
    <>
      {missing.length > 0 && !installing ? (
        <p class="error-text">
          {name} needs {missing.join(" and ")}, which isn't installed.
        </p>
      ) : null}
      {needs.installable && (installing || missing.length > 0 || missingServer !== null) ? (
        installing ? (
          <InstallProgress
            label={`Installing ${name}…`}
            since={installingSince}
            progress={install.progress}
            onCancel={onCancel}
          />
        ) : miseInstalled ? (
          <>
            <button type="button" class="pill primary" onClick={() => void start()}>
              Install with mise
            </button>
            <p class="muted small">
              Installs {name} and its language server for {scope} only, without changing anything
              else on the server. It can take several minutes.
            </p>
          </>
        ) : (
          <p class="muted small">
            Install it yourself, or install{" "}
            <a href="https://mise.jdx.dev/getting-started.html" target="_blank" rel="noreferrer">
              mise
            </a>{" "}
            on the server and Workshop can install it for {scope} only.{" "}
            <button type="button" class="text-button" onClick={onRefresh}>
              Check again
            </button>
          </p>
        )
      ) : null}
      {problem ? <p class="error-text small">{problem}</p> : null}
      {install.last_install && !installing ? <LastInstallLog last={install.last_install} /> : null}
      {missingServer && !installing ? (
        <p class="muted small">Optional: install {missingServer} for error underlines and types.</p>
      ) : null}
      {error ? <p class="error-text">{error}</p> : null}
    </>
  );
}
