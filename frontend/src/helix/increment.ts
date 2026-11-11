// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-core's increment/integer.rs.

import { at } from "./text";

const SEPARATOR = "_";

/**
 * Adds `amount` to the integer `text`, keeping its base (`0x`, `0o`, `0b` or decimal), zero
 * padding, `_` separators and hex case, or returns null if `text` isn't an integer. Only decimal
 * integers go negative.
 */
export function incrementInteger(text: string, amount: number): string | null {
  if (text === "" || text.endsWith(SEPARATOR) || text.startsWith(SEPARATOR)) return null;
  const radix = text.startsWith("0x")
    ? 16
    : text.startsWith("0o")
      ? 8
      : text.startsWith("0b")
        ? 2
        : 10;
  const chars = [...text];
  // Separator indexes from right to left.
  const separators: number[] = [];
  chars.reverse().forEach((c, i) => {
    if (c === SEPARATOR) separators.push(i);
  });
  const word = text.replaceAll(SEPARATOR, "");
  let out: string;
  if (radix === 10) {
    if (!/^[+-]?\d+$/.test(word)) return null;
    const value = BigInt(word);
    const next = value + BigInt(amount);
    const negBefore = value < 0n;
    const negAfter = next < 0n;
    let length = word.length;
    if (negBefore && !negAfter) length--;
    else if (!negBefore && negAfter) length++;
    length -= separators.length;
    if (word.startsWith("0") || word.startsWith("-0")) {
      out = padSigned(next, length);
    } else {
      out = next.toString();
    }
  } else {
    const digits = word.slice(2);
    const valid = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[01]+$/;
    if (!valid.test(digits)) return null;
    const value = BigInt(`0${radix === 16 ? "x" : radix === 8 ? "o" : "b"}${digits}`);
    let next = value + BigInt(amount);
    if (next < 0n) next = 0n;
    const length = text.length - 2 - separators.length;
    let body = next.toString(radix);
    if (radix === 16) {
      let lower = 0;
      let upper = 0;
      for (const c of digits) {
        if (c >= "a" && c <= "z") lower++;
        if (c >= "A" && c <= "Z") upper++;
      }
      if (upper > lower) body = body.toUpperCase();
    }
    out = `${text.slice(0, 2)}${body.padStart(length, "0")}`;
  }

  // Put the separators back where they were.
  for (const rtl of separators) {
    if (rtl < out.length) {
      const index = out.length - rtl;
      if (index > 0) out = out.slice(0, index) + SEPARATOR + out.slice(index);
    }
  }
  // Add more separators if the number grew.
  if (out.length > text.length && separators.length > 0) {
    const spacing =
      separators.length >= 2
        ? at(separators, separators.length - 1) - at(separators, separators.length - 2) - 1
        : at(separators, 0);
    const prefix = radix === 10 ? 0 : 2;
    let index = out.indexOf(SEPARATOR);
    if (index !== -1) {
      while (index - prefix > spacing) {
        index -= spacing;
        out = out.slice(0, index) + SEPARATOR + out.slice(index);
      }
    }
  }
  return out;
}

/** Rust's `format!("{:01$}", value, width)`: zero padded, with the sign counting towards it. */
function padSigned(value: bigint, width: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const body = digits.padStart(Math.max(0, width - (negative ? 1 : 0)), "0");
  return negative ? `-${body}` : body;
}
