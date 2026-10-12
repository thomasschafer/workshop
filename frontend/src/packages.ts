import type { PackageHints, PackagesState } from "./api";

/** Whether everything listed is installed, with nothing wrong with the list. */
export function isUpToDate(state: PackagesState): boolean {
  if (state.problem !== null) return false;
  if (state.packages.length === 0) return true;
  const { installed } = state;
  return (
    installed !== null &&
    installed.length === state.packages.length &&
    installed.every((p, i) => p === state.packages[i])
  );
}

export interface MissingPackage {
  module: string;
  /** The package that provides the module, if it's known. */
  package: string | null;
}

/** Finds a module that errors say is missing, and the package that would provide it. */
export function findMissingPackage(text: string, hints: PackageHints): MissingPackage | null {
  for (const pattern of hints.missing_module) {
    const module = new RegExp(pattern).exec(text)?.[1];
    if (module) return { module, package: providerOf(module, hints) };
  }
  return null;
}

function providerOf(module: string, hints: PackageHints): string | null {
  // The longest prefix wins, so `Data.Graph.Inductive` isn't taken for `Data.Graph`.
  let best: { prefix: string; package: string } | null = null;
  for (const [prefix, pkg] of Object.entries(hints.providers)) {
    const matches = module === prefix || module.startsWith(`${prefix}.`);
    if (matches && (best === null || prefix.length > best.prefix.length)) {
      best = { prefix, package: pkg };
    }
  }
  if (best) return best.package;
  return hints.package_named_after_module ? (module.split(".")[0] ?? null) : null;
}

/** A package name as spoken, such as "unordered containers" for `unordered-containers`. */
export function spokenPackageName(words: string): string | null {
  const name = words.trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9][a-z0-9._-]*$/.test(name) ? name : null;
}
