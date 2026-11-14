// Compares what was typed with what a program prints, as crates/pack/src/output.rs does, and
// tested against the same cases.

/** The lines of some output, without whitespace at their ends or blank lines around them. */
export function normaliseOutput(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  const start = lines.findIndex((line) => line !== "");
  if (start === -1) return "";
  let end = lines.length - 1;
  while (lines[end] === "") end--;
  return lines.slice(start, end + 1).join("\n");
}

export function sameOutput(expected: string, actual: string): boolean {
  return normaliseOutput(expected) === normaliseOutput(actual);
}
