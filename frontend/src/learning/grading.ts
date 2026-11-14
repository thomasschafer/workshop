// Grading typed answers on the device, so it can say straight away whether one was right,
// offline too. It must agree with crates/pack/src/number.rs, which grading.test.ts checks
// against the cases in crates/pack/tests/grading.json.

import type { Tolerance } from "./types";

/** A plain decimal, without exponents, infinities or NaN. */
function decimal(text: string): number | null {
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : null;
}

/**
 * Reads a number as a learner writes it: an integer, a decimal, a fraction such as `5/36`, or a
 * percentage such as `12.5%`. Spaces and thousands separators are ignored.
 */
export function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[\s,_]/g, "").replace(/−/g, "-");
  if (cleaned === "") return null;
  let value: number | null;
  if (cleaned.endsWith("%")) {
    const percent = decimal(cleaned.slice(0, -1));
    value = percent === null ? null : percent / 100;
  } else if (cleaned.includes("/")) {
    const slash = cleaned.indexOf("/");
    const numerator = decimal(cleaned.slice(0, slash));
    const denominator = decimal(cleaned.slice(slash + 1));
    value =
      numerator === null || denominator === null || denominator === 0
        ? null
        : numerator / denominator;
  } else {
    value = decimal(cleaned);
  }
  return value !== null && Number.isFinite(value) ? value : null;
}

/** Whether `response` is a right answer, or null if it can't be read as a number at all. */
export function grade(expected: number, tolerance: Tolerance, response: string): boolean | null {
  const given = parseNumber(response);
  if (given === null) return null;
  const close =
    Math.abs(given - expected) <=
    Math.max(tolerance.absolute, tolerance.relative * Math.abs(expected));
  const ratio = given / expected;
  const sameMagnitude =
    tolerance.factor !== undefined &&
    ratio > 0 &&
    ratio <= tolerance.factor &&
    ratio >= 1 / tolerance.factor;
  return close || sameMagnitude;
}

/** The tolerance every answer gets, which is too small to mention. */
const HAIRS_BREADTH = 1e-9;

/**
 * How close an answer must be, to show with a question that's an estimate, such as "within 5%",
 * or null when it must be exact.
 */
export function describeTolerance(tolerance: Tolerance): string | null {
  const bounds = [
    tolerance.absolute > HAIRS_BREADTH ? `${displayNumber(tolerance.absolute)} either way` : null,
    tolerance.relative > 0 ? `${displayNumber(tolerance.relative * 100)}%` : null,
    tolerance.factor !== undefined ? `a factor of ${displayNumber(tolerance.factor)}` : null,
  ].filter((bound) => bound !== null);
  return bounds.length === 0 ? null : `within ${bounds.join(" or ")}`;
}

/** An estimate's exact answer, to four significant figures, grouped in thousands. */
export function displayApproximate(value: number): string {
  return new Intl.NumberFormat("en-GB", { maximumSignificantDigits: 4 }).format(value);
}

/** A number as the app shows it: integers as they are, others to at most six decimal places. */
export function displayNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
