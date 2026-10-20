import type { Diagnostics, LanguageServerStatus } from "../editor";
import type { SaveStatus } from "../saver";

/** The line above the code: the language server's checks, saving, and the type under the cursor. */
export function StatusLine({
  checks,
  diagnostics,
  saveStatus,
  hover,
}: {
  /** The language server's status, or null if the language has none. */
  checks: LanguageServerStatus | null;
  diagnostics: Diagnostics;
  saveStatus: SaveStatus;
  hover: string | null;
}) {
  const statusParts: string[] = [];
  if (checks !== null && checks !== "ready") {
    statusParts.push("starting checks");
  } else if (checks !== null) {
    statusParts.push(
      diagnostics.errors || diagnostics.warnings
        ? `${diagnostics.errors} error${diagnostics.errors === 1 ? "" : "s"}${diagnostics.warnings ? `, ${diagnostics.warnings} warning${diagnostics.warnings === 1 ? "" : "s"}` : ""}`
        : "no errors",
    );
  }
  if (saveStatus === "error") statusParts.push("not saved");
  else if (saveStatus !== "saved" && saveStatus !== "conflict") statusParts.push("saving");
  return (
    <div class="status-line">
      <span>{statusParts.join(" · ")}</span>
      {hover ? <code class="hover">{hover}</code> : null}
    </div>
  );
}
