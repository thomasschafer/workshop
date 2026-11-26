// Representative TypeScript module for syntax highlighting parity with Helix.
// TODO(alice): keep common TypeScript constructs and injections covered (#42)
// FIXME: check https://example.com/docs and @bob mentions

/**
 * Computes a weighted score for a named entry.
 *
 * @param entry - The entry to evaluate.
 * @param factor - Optional multiplier.
 * @returns The rounded numeric score.
 * @example
 * ```ts
   const n = score({ name: "a", value: 2 }, 1.5);
 * ```
 */
export interface Entry<T = number> {
  readonly name: string;
  value: T;
  tags?: string[];
}

export type Colour = "red" | "green" | "blue";

export enum Mode {
  Fast = 1,
  Exact = 2,
}

const TOKEN_RE = /^([a-z_]+):(\d+)$/i;

export class Accumulator<T extends number> {
  private total = 0;

  constructor(private readonly scale: T) {}

  add(entry: Entry<number>): number {
    const match = TOKEN_RE.exec(entry.name);
    const bonus = match ? Number(match[2]) : 0;
    this.total += entry.value * this.scale + bonus;
    return this.total;
  }
}

export async function evaluate(entries: readonly Entry[], mode: Mode): Promise<string> {
  const acc = new Accumulator(mode === Mode.Fast ? 1 : 2);
  let sum = 0;
  for (const item of entries) {
    if (item.value < 0) {
      throw new Error(`negative value for ${item.name}`);
    }
    sum = acc.add(item);
  }
  const colour: Colour = sum > 10 ? "green" : "red";
  return Promise.resolve(`${colour}:${sum}`);
}
