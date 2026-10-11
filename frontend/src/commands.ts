/** Voice commands that are handled instantly in the app, without the model. */
export type LocalCommand =
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "run"; input: "sample" | "real" }
  | { kind: "submit" }
  | { kind: "gotoLine"; line: number }
  | { kind: "nextError" }
  | { kind: "previousError" }
  | { kind: "snippet"; name: string }
  | { kind: "tab"; tab: "problem" | "code" | "notes" | "discuss" };

const SMALL: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  to: 2,
  too: 2,
  three: 3,
  four: 4,
  for: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Parses "12", "twelve", "one hundred and four" or "forty two". */
export function parseNumber(words: string): number | null {
  const trimmed = words.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  let total = 0;
  let current = 0;
  let seen = false;
  for (const word of trimmed.split(/[\s-]+/)) {
    if (word === "and" || word === "") {
      continue;
    }
    const small = SMALL[word];
    const tens = TENS[word];
    if (small !== undefined) {
      current += small;
    } else if (tens !== undefined) {
      current += tens;
    } else if (word === "hundred") {
      current = (current || 1) * 100;
    } else if (word === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
    } else {
      return null;
    }
    seen = true;
  }
  return seen ? total + current : null;
}

export function normalise(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/[.,!?;:"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchCommand(
  utterance: string,
  snippetNames: readonly string[],
): LocalCommand | null {
  const text = normalise(utterance);
  if (/^undo( that)?$/.test(text)) return { kind: "undo" };
  if (/^redo( that)?$/.test(text)) return { kind: "redo" };
  if (/^run( it)?( on)?( the)? (sample|example)( input)?$/.test(text)) {
    return { kind: "run", input: "sample" };
  }
  if (/^run( it)?( on)?( the)? (real|full|actual|puzzle)( input)?$/.test(text)) {
    return { kind: "run", input: "real" };
  }
  if (/^submit( (it|that|the answer))?$/.test(text)) return { kind: "submit" };
  if (/^(next|go to next) (error|problem|diagnostic)$/.test(text)) return { kind: "nextError" };
  if (/^(previous|last|go to previous) (error|problem|diagnostic)$/.test(text)) {
    return { kind: "previousError" };
  }
  const tab = text.match(/^(show|open|go to)( the)? (problem|puzzle|code|notes|chat|discussion)$/);
  if (tab?.[3]) {
    const name = tab[3];
    if (name === "problem" || name === "puzzle") return { kind: "tab", tab: "problem" };
    if (name === "code") return { kind: "tab", tab: "code" };
    if (name === "notes") return { kind: "tab", tab: "notes" };
    return { kind: "tab", tab: "discuss" };
  }
  const line = text.match(/^(go to|goto|jump to) line (.+)$/);
  if (line?.[2]) {
    const number = parseNumber(line[2]);
    if (number !== null && number > 0) return { kind: "gotoLine", line: number };
  }
  const snippet = text.match(/^(insert )?snippet (.+)$/);
  if (snippet?.[2]) {
    const wanted = snippet[2];
    const found = snippetNames.find((name) => normalise(name) === wanted);
    if (found !== undefined) return { kind: "snippet", name: found };
  }
  return null;
}
