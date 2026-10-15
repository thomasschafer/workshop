import { useEffect, useState } from "preact/hooks";
import type { Resolution } from "../api";
import type { Packages, PackagesActivity } from "../hooks/usePackages";
import { isUpToDate, type MissingModule } from "../packages";
import { InstallProgress, LastInstallLog } from "./install";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What's under way, in a few words. */
function describe(activity: PackagesActivity | null): string {
  switch (activity?.kind) {
    case "add":
      return `Installing ${activity.package}…`;
    case "remove":
      return `Removing ${activity.package}…`;
    default:
      return "Installing packages…";
  }
}

function PackagesProgress({ packages }: { packages: Packages }) {
  return (
    <InstallProgress
      label={describe(packages.activity)}
      since={packages.installingSince}
      progress={packages.progress}
      onCancel={packages.cancel}
    />
  );
}

/** The packages solutions can use: adding, removing and installing them, and editing the list. */
export function PackagesSection({
  packages,
  heading = true,
}: {
  packages: Packages;
  heading?: boolean;
}) {
  const { state } = packages;
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  if (state === null) return null;

  const add = async (event: Event) => {
    event.preventDefault();
    const name = adding.trim();
    if (!name) return;
    if (await packages.add(name)) setAdding("");
  };
  const saveAndInstall = async (text: string) => {
    setFormError(null);
    try {
      await packages.save(text);
    } catch (e) {
      setFormError(message(e));
      return;
    }
    setEditing(null);
    await packages.install();
  };
  const busy = packages.installing;

  return (
    <div class="packages">
      {heading ? <h2>Packages</h2> : null}
      {state.missing_programs.length > 0 && state.packages.length > 0 ? (
        <p class="error-text small">
          Installing packages needs {state.missing_programs.join(" and ")}, which isn't on your
          PATH.
        </p>
      ) : null}
      {state.packages.length > 0 ? (
        <div class="snippets wrap">
          {state.packages.map((p) => (
            <span key={p} class="chip static">
              {p}
              <button
                type="button"
                class="chip-remove"
                aria-label={`Remove ${p}`}
                disabled={busy}
                onClick={() => void packages.remove(p)}
              >
                ✕
              </button>
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
      {busy ? (
        <PackagesProgress packages={packages} />
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
      {packages.lastInstall && !busy ? <LastInstallLog last={packages.lastInstall} /> : null}
      <form class="add-package" onSubmit={add}>
        <input
          value={adding}
          onInput={(e) => setAdding((e.target as HTMLInputElement).value)}
          placeholder="Add a package"
          autocapitalize="off"
          autocomplete="off"
          spellcheck={false}
          disabled={busy}
        />
        <button type="submit" class="pill" disabled={busy || adding.trim() === ""}>
          Add
        </button>
      </form>
      {editing === null ? (
        <p class="muted small">
          The list is <code>{state.manifest}</code> in your solutions folder.{" "}
          <button
            type="button"
            class="text-button"
            disabled={busy}
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
          {formError ? <p class="error-text small">{formError}</p> : null}
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

type Lookup = Resolution | { kind: "looking" } | { kind: "failed"; reason: string };

/** Offers to install the package for a module that an error says is missing. */
export function MissingPackageBanner({
  missing,
  packages,
  onInstall,
  onOpenSettings,
}: {
  missing: MissingModule;
  packages: Packages;
  onInstall: (pkg: string) => void;
  onOpenSettings: () => void;
}) {
  const [lookup, setLookup] = useState<Lookup>({ kind: "looking" });
  const { module } = missing;
  const named = missing.package;
  const { resolve } = packages;
  useEffect(() => {
    if (named !== null) {
      setLookup({ kind: "known", package: named });
      return;
    }
    let current = true;
    setLookup({ kind: "looking" });
    resolve(module)
      .then((found) => current && setLookup(found))
      .catch((e: unknown) => current && setLookup({ kind: "failed", reason: message(e) }));
    return () => {
      current = false;
    };
  }, [module, named]);

  const pkg = "package" in lookup ? lookup.package : null;
  // Errors from before an install go once the code is checked or run again.
  if (pkg !== null && packages.state?.installed?.includes(pkg) && !packages.installing) {
    return null;
  }
  if (packages.installing) {
    return (
      <div class="banner">
        <PackagesProgress packages={packages} />
      </div>
    );
  }
  return (
    <div class="banner">
      <span>
        <code>{module}</code> isn't installed.
        {lookup.kind === "not_found" ? " No package provides it." : null}
        {lookup.kind === "failed" ? " Couldn't look up its package." : null}
        {packages.error ? <span class="error-text"> The last install failed.</span> : null}
      </span>
      <span class="banner-actions">
        {lookup.kind === "looking" ? <span class="muted">Looking up its package…</span> : null}
        {pkg !== null ? (
          <button type="button" class="text-button" onClick={() => onInstall(pkg)}>
            Install {pkg}
          </button>
        ) : null}
        {lookup.kind === "not_found" || lookup.kind === "failed" || packages.error ? (
          <button type="button" class="text-button" onClick={onOpenSettings}>
            {packages.error ? "Details" : "Add its package"}
          </button>
        ) : null}
      </span>
      {lookup.kind === "found" && lookup.summary ? (
        <span class="banner-detail">
          {lookup.package}: {lookup.summary}
        </span>
      ) : null}
    </div>
  );
}

/** Offers to install packages that are listed but not installed, such as after editing the list. */
export function OutdatedPackagesBanner({
  packages,
  onDismiss,
}: {
  packages: Packages;
  onDismiss: () => void;
}) {
  const { state } = packages;
  if (state === null) return null;
  if (packages.installing) {
    return (
      <div class="banner">
        <PackagesProgress packages={packages} />
      </div>
    );
  }
  return (
    <div class="banner">
      <span>
        {state.installed === null
          ? `The packages in ${state.manifest} aren't installed yet.`
          : `${state.manifest} changed since the packages were installed.`}
      </span>
      <span class="banner-actions">
        <button type="button" class="text-button" onClick={() => void packages.install()}>
          Install
        </button>
        <button type="button" class="text-button" onClick={onDismiss}>
          Not now
        </button>
      </span>
    </div>
  );
}
