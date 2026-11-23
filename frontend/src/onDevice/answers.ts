// Advent of Code answer parsing & decimal warnings, mirroring `src/runner.rs` and verified
// against the shared `crates/runner/tests/answers.json` fixture.

/** Extracts non-empty answer lines from stdout, stripping Haskell String quotes and JS BigInt `n`. */
export function parseAnswers(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseAnswerLine);
}

/** Warns on the first two answers if either looks like a decimal or scientific-notation float. */
export function answerWarnings(answers: readonly string[]): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < Math.min(2, answers.length); i++) {
    const value = answers[i];
    if (value !== undefined && looksLikeDecimal(value)) {
      warnings.push(
        `Part ${i + 1}'s answer, ${value}, looks like a decimal, but Advent of Code's answers are whole numbers. Is a division or a float type giving it?`,
      );
    }
  }
  return warnings;
}

function parseAnswerLine(line: string): string {
  if (line.length >= 3 && line.startsWith('"') && line.endsWith('"')) {
    const inner = line.slice(1, -1);
    if (!inner.includes('"')) {
      return inner;
    }
  }
  if (line.endsWith("n")) {
    const number = line.slice(0, -1);
    if (isInteger(number)) {
      return number;
    }
  }
  return line;
}

function isInteger(text: string): boolean {
  const digits = text.startsWith("-") ? text.slice(1) : text;
  if (digits.length === 0) return false;
  for (let i = 0; i < digits.length; i++) {
    const c = digits.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function looksLikeDecimal(answer: string): boolean {
  const unsigned = answer.startsWith("-") ? answer.slice(1) : answer;
  const eIdx = unsigned.search(/[eE]/);
  let mantissa = unsigned;
  let exponent: string | null = null;
  if (eIdx !== -1) {
    mantissa = unsigned.slice(0, eIdx);
    const rawExp = unsigned.slice(eIdx + 1);
    exponent = rawExp.startsWith("+") || rawExp.startsWith("-") ? rawExp.slice(1) : rawExp;
  }
  const dotIdx = mantissa.indexOf(".");
  let mantissaOk: boolean;
  if (dotIdx !== -1) {
    mantissaOk = isInteger(mantissa.slice(0, dotIdx)) && isInteger(mantissa.slice(dotIdx + 1));
  } else {
    mantissaOk = isInteger(mantissa);
  }
  if (!mantissaOk) return false;
  return exponent !== null ? isInteger(exponent) : dotIdx !== -1;
}
