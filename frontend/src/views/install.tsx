import { useState } from "preact/hooks";
import type { LastInstall } from "../api";
import { useElapsed } from "../hooks/useElapsed";

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
