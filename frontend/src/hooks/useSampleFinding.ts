import type { RefObject } from "preact";
import { useCallback, useRef, useState } from "preact/hooks";
import { api, type DayMeta, type Problem, type Puzzle } from "../api";
import { errorMessage } from "../errors";
import { isPractice } from "../puzzle";
import { needsSample, type PartIndex, withFoundSample } from "../samples";

/** Finding each part's example with the edit model, when the puzzle's page doesn't make it clear. */
export function useSampleFinding(
  puzzleRef: RefObject<Puzzle | null>,
  metaRef: RefObject<DayMeta>,
  updateMeta: (next: DayMeta) => void,
) {
  /** Parts whose example the edit model is looking for, for the puzzle open now. */
  const [findingSamples, setFindingSamples] = useState<readonly PartIndex[]>([]);
  /** Puzzle parts already looked for in this session, by "year-day-part". */
  const soughtSamples = useRef(new Set<string>());
  /**
   * Asks the edit model for the example of each part that's still missing one, as older puzzles
   * often give theirs inline rather than in a code block. One part at a time, as part 2's
   * example is often part 1's.
   */
  const findSamples = useCallback(
    async (p: Puzzle, loaded: Problem) => {
      // Before 2020, puzzles often emphasise something other than the example's answer, so what
      // the page's structure suggests is checked too. Since then it has been reliable.
      const distrust = !isPractice(p) && p.year < 2020;
      const parts = ([0, 1] as const).slice(0, loaded.parts_html.length);
      for (const part of parts) {
        const key = `${p.year}-${p.day}-${part}`;
        if (
          soughtSamples.current.has(key) ||
          !needsSample(metaRef.current, loaded, part, distrust)
        ) {
          continue;
        }
        soughtSamples.current.add(key);
        setFindingSamples((f) => [...f, part]);
        try {
          const found = await api.findSample(p, part + 1);
          if (found && puzzleRef.current === p) {
            const updated = withFoundSample(metaRef.current, loaded, part, found, distrust);
            if (updated !== metaRef.current) updateMeta(updated);
          }
        } catch (e) {
          // Asked again next time; the sample can still be chosen by hand meanwhile.
          soughtSamples.current.delete(key);
          console.warn(`Couldn't find part ${part + 1}'s example: ${errorMessage(e)}`);
        } finally {
          setFindingSamples((f) => f.filter((x) => x !== part));
        }
      }
    },
    [updateMeta],
  );
  return { findingSamples, setFindingSamples, findSamples };
}
