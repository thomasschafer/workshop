import { useEffect, useRef } from "preact/hooks";
import type { Puzzle } from "../api";

/**
 * Offered once per puzzle whenever part 1 is solved and the code hasn't started part 2: just
 * after submitting, or on coming back to the puzzle later.
 */
export function usePartTwoOffer(
  queue: { offer: (text: string, action: string, act: () => void) => void },
  puzzle: Puzzle | null,
  part: number | null,
  part2Started: boolean | null,
  start: () => void,
): void {
  const offeredPartTwo = useRef<string | null>(null);
  useEffect(() => {
    if (!puzzle || part !== 2 || part2Started !== false) return;
    const key = `${puzzle.year}-${puzzle.day}`;
    if (offeredPartTwo.current === key) return;
    offeredPartTwo.current = key;
    queue.offer("Part 1 solved. Start part 2?", "Start part 2", start);
  }, [puzzle, part, part2Started]);
}
