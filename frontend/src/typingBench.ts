// Comparing how accurately Workshop's own keyboard and the phone's are typed on, with the same
// phrases, keeping every touch on Workshop's keyboard so other ways of reading them can be tried.

import type { KeyBox, KeyOffsets, Point } from "./touchModel";
import { editDistance } from "./wer";

export type PhraseKind = "prose" | "code";

export interface TypingPhrase {
  readonly kind: PhraseKind;
  readonly text: string;
}

/**
 * Prose, in lower case letters alone, which any keyboard types alike, then code, with the symbols
 * code needs. All invented.
 */
export const TYPING_PHRASES: readonly TypingPhrase[] = [
  { kind: "prose", text: "she walked down to the river after lunch" },
  { kind: "prose", text: "the train was late again so we took a bus" },
  { kind: "prose", text: "please bring the blue folder to the meeting" },
  { kind: "prose", text: "my brother never learned how to swim well" },
  { kind: "prose", text: "we should plant more trees along this road" },
  { kind: "prose", text: "every morning the old dog waits by the door" },
  { kind: "code", text: "for i in range(len(xs)):" },
  { kind: "code", text: "total = sum(x * 2 for x in nums)" },
  { kind: "code", text: "if (a && !b) { return c[0]; }" },
  { kind: "code", text: "let mut seen = HashSet::new();" },
  { kind: "code", text: "map (\\x -> x + 1) [1..10]" },
  { kind: "code", text: 'print(f"{name}: {count}")' },
  { kind: "code", text: "fn parse(s: &str) -> Option<u32> {" },
  { kind: "code", text: "where go acc (y:ys) = go (acc + y) ys" },
];

/** Which keyboard a run is typed on, and for the phone's, whether its corrections were on. */
export type TypingKeyboard = "workshop" | "phone-corrections-on" | "phone-corrections-off";

/** A phrase as it was typed. */
export interface TypedPhrase {
  readonly kind: PhraseKind;
  readonly target: string;
  readonly typed: string;
  /** From the first character typed to the last, in milliseconds. */
  readonly ms: number;
}

export interface TypingScore {
  /** The share of the phrases' characters that were wrong, missing or added: 0 is perfect. */
  readonly errorRate: number;
  readonly characters: number;
  /** Characters typed a minute, each phrase timed from its first character to its last. */
  readonly perMinute: number;
}

/** How well some phrases were typed, all taken together, or null if there are none. */
export function score(phrases: readonly TypedPhrase[]): TypingScore | null {
  if (phrases.length === 0) return null;
  let errors = 0;
  let characters = 0;
  let ms = 0;
  let timed = 0;
  for (const phrase of phrases) {
    errors += editDistance([...phrase.target], [...phrase.typed]);
    characters += [...phrase.target].length;
    ms += phrase.ms;
    // The first character starts the clock, so the time covers all the rest.
    timed += Math.max([...phrase.typed].length - 1, 0);
  }
  return {
    errorRate: characters > 0 ? errors / characters : 0,
    characters,
    perMinute: ms > 0 ? (timed / ms) * 60_000 : 0,
  };
}

/** A touch on Workshop's keyboard during the benchmark, as the browser reported it. */
export interface RecordedPress {
  /** The key it pressed, by its id in the layout. */
  readonly key: string;
  /** The pointer that made it, which its lift names. */
  readonly pointer: number;
  /** The keys it typed, in Helix's notation, more than one if it was held down. */
  readonly typed: string[];
  readonly down: Point & { readonly t: number };
  /** Where the finger lifted, or null if the phrase was saved first, as by the Enter ending it. */
  up: (Point & { readonly t: number }) | null;
  /** The size of the finger's contact, in the page's pixels, and its pressure, if known. */
  readonly width: number;
  readonly height: number;
  readonly pressure: number;
}

/** What a phrase on Workshop's keyboard saves beyond its text: every touch, and the keys. */
export interface RecordedKeyboard {
  readonly column: number;
  readonly boxes: readonly KeyBox[];
  /** Where the keys were taken to be touched, which decided what each touch pressed. */
  readonly offsets: KeyOffsets;
  readonly presses: readonly RecordedPress[];
}
