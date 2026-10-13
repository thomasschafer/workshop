// Scoring speech recognition against what was meant to be said, for the benchmark.

/** Symbols as the words someone would say for them, so either form scores the same. */
const SYMBOL_WORDS: [RegExp, string][] = [
  [/\(/g, " open bracket "],
  [/\)/g, " close bracket "],
  [/\[/g, " open square bracket "],
  [/\]/g, " close square bracket "],
  [/:/g, " colon "],
  [/\$/g, " dollar "],
  [/>/g, " greater than "],
  [/</g, " less than "],
  [/\+/g, " plus "],
  [/=/g, " equals "],
  [/\*/g, " times "],
  [/_/g, " underscore "],
];

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A number below a thousand in words, as it would be said. */
function numberWords(n: number): string {
  if (n < 20) return ONES[n] ?? String(n);
  if (n < 100) {
    const rest = n % 10;
    return `${TENS[Math.floor(n / 10)]}${rest ? ` ${ONES[rest]}` : ""}`;
  }
  if (n < 1000) {
    const rest = n % 100;
    return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${numberWords(rest)}` : ""}`;
  }
  return String(n);
}

/**
 * Text as a list of spoken words, for comparing: lower case, symbols and digits as words, and
 * names like `part1` split, with a full stop that ends a sentence dropped but a dot between words
 * kept as "dot".
 */
export function spokenWords(text: string): string[] {
  let spoken = text
    .replace(/\.(?=\s*$)/g, " ")
    .replace(/\.(?=\s+[A-Z])/g, " ")
    .replace(/\./g, " dot ")
    .replace(/,/g, " ");
  for (const [symbol, words] of SYMBOL_WORDS) spoken = spoken.replace(symbol, words);
  spoken = spoken
    .replace(/([a-z])([0-9])/gi, "$1 $2")
    .replace(/([0-9])([a-z])/gi, "$1 $2")
    .replace(/[0-9]+/g, (digits) => ` ${numberWords(Number(digits))} `)
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ");
  return spoken.split(/\s+/).filter((w) => w !== "");
}

/** The share of the expected words that were wrong, missing or added: 0 is perfect. */
export function wordErrorRate(expected: string, heard: string): number {
  const want = spokenWords(expected);
  const got = spokenWords(heard);
  if (want.length === 0) return got.length === 0 ? 0 : 1;
  // Edit distance over words.
  let previous = Array.from({ length: got.length + 1 }, (_, j) => j);
  for (let i = 1; i <= want.length; i++) {
    const current = [i];
    for (let j = 1; j <= got.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (want[i - 1] === got[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return (previous[got.length] ?? 0) / want.length;
}
