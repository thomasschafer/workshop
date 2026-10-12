import { useState } from "preact/hooks";
import { useElapsed } from "../hooks/useElapsed";
import type { Packages } from "../hooks/usePackages";
import { isUpToDate, type MissingPackage } from "../packages";

/** Shows how long an install has taken, while one is under way. */
function Installing({ since, what }: { since: number | null; what: string }) {
  const elapsed = useElapsed(since);
  return (
    <span class="installing">
      Installing {what}…{" "}
      {elapsed === null ? null : <span class="elapsed">{elapsed.toFixed(0)}s</span>}
    </span>
  );
}

/** The packages solutions can use, installing them, and editing the list by hand. */
export function PackagesSection({
  packages,
  heading = true,
}: {
  packages: Packages;
  heading?: boolean;
}) {
  const { state } = packages;
  const [editing, setEditing] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (state === null) return null;

  const saveAndInstall = async (text: string) => {
    setSaveError(null);
    try {
      await packages.save(text);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      return;
    }
    setEditing(null);
    await packages.install();
  };

  return (
    <div class="packages">
      {heading ? <h2>Packages</h2> : null}
      {state.packages.length > 0 ? (
        <div class="snippets">
          {state.packages.map((p) => (
            <span key={p} class="chip static">
              {p}
            </span>
          ))}
        </div>
      ) : state.problem === null ? (
        <p class="muted small">
          None yet. The standard library covers most puzzles; add a package here, or when an error
          says one is missing.
        </p>
      ) : null}
      {state.problem ? <p class="error-text small">{state.problem}</p> : null}
      {packages.installing ? (
        <p class="small">
          <Installing since={packages.installingSince} what="packages" />
        </p>
      ) : isUpToDate(state) ? (
        state.packages.length > 0 ? (
          <p class="muted small">Installed.</p>
        ) : null
      ) : state.problem !== null ? null : (
        <p class="small">
          {state.installed === null
            ? "Not installed yet. "
            : "The list changed since the last install. "}
          <button type="button" class="text-button" onClick={() => void packages.install()}>
            Install
          </button>
        </p>
      )}
      {packages.error ? <pre class="install-error">{packages.error}</pre> : null}
      {editing === null ? (
        <p class="muted small">
          The list is <code>{state.manifest}</code> in your solutions folder.{" "}
          <button
            type="button"
            class="text-button"
            disabled={packages.installing}
            onClick={() => setEditing(state.text)}
          >
            Edit it
          </button>
        </p>
      ) : (
        <div class="manifest-editor">
          <textarea
            value={editing}
            onInput={(e) => setEditing((e.target as HTMLTextAreaElement).value)}
            spellcheck={false}
            autocapitalize="off"
            rows={Math.min(14, editing.split("\n").length + 1)}
          />
          {saveError ? <p class="error-text small">{saveError}</p> : null}
          <div class="snippets">
            <button type="button" class="pill" onClick={() => void saveAndInstall(editing)}>
              Save and install
            </button>
            <button type="button" class="text-button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Offers to install a package that an error says is missing. */
export function MissingPackageBanner({
  missing,
  packages,
  onInstall,
  onOpenSettings,
}: {
  missing: MissingPackage;
  packages: Packages;
  onInstall: (pkg: string) => void;
  onOpenSettings: () => void;
}) {
  const pkg = missing.package;
  return (
    <div class="banner">
      {packages.installing ? (
        <Installing since={packages.installingSince} what={pkg ?? "packages"} />
      ) : (
        <>
          <span>
            <code>{missing.module}</code> isn't installed.
            {packages.error ? <span class="error-text"> The last install failed.</span> : null}
          </span>
          <span class="banner-actions">
            {pkg ? (
              <button type="button" class="text-button" onClick={() => onInstall(pkg)}>
                Install {pkg}
              </button>
            ) : null}
            <button type="button" class="text-button" onClick={onOpenSettings}>
              {pkg ? "Packages" : "Add its package"}
            </button>
          </span>
        </>
      )}
    </div>
  );
}
