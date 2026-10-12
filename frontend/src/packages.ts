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

export interface MissingModule {
  module: string;
  /** The package, when the error names it. */
  package: string | null;
}

/** Finds a module that errors say is missing, and its package if they name that too. */
export function findMissingModule(text: string, hints: PackageHints): MissingModule | null {
  const module = firstMatch(text, hints.missing_module);
  return module === null ? null : { module, package: firstMatch(text, hints.missing_package) };
}

function firstMatch(text: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    const found = new RegExp(pattern).exec(text)?.[1];
    if (found) return found;
  }
  return null;
}

/** A package name as spoken, such as "unordered containers" for `unordered-containers`. */
export function spokenPackageName(words: string): string | null {
  const name = words.trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9][a-z0-9._-]*$/.test(name) ? name : null;
}
