// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// How Helix builds regexes from what's typed: multi-line, and case-insensitive with smart case
// unless the pattern has a capital letter.

/**
 * Builds a global regex from `pattern`, or returns the error that compiling it gave. Helix's
 * regexes are Rust's, which JavaScript's mostly agree with; Unicode mode is used where the
 * pattern allows it, as Rust's regexes are Unicode-aware.
 */
export function buildRegex(pattern: string, smartCase: boolean): RegExp | Error {
  const caseInsensitive = smartCase && !/\p{Lu}/u.test(pattern);
  const flags = `gm${caseInsensitive ? "i" : ""}`;
  try {
    return new RegExp(pattern, `${flags}u`);
  } catch {
    // Unicode mode rejects escapes Rust allows, such as `\#`.
  }
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** Escapes `s` to match itself, as Rust's `regex::escape` does, in a form JavaScript reads too. */
export function escapeRegex(s: string): string {
  return s.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&");
}
