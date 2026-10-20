import type { RefObject } from "preact";
import { useCallback, useRef, useState } from "preact/hooks";
import { api, type DayMeta, type Puzzle } from "../api";
import { EMPTY_META } from "../samples";
import { LatestSaver } from "../saver";

/**
 * What's kept for the open puzzle besides its code and notes, such as the chosen sample and the
 * cursor, saved shortly after each change.
 */
export function useDayMeta(
  puzzleRef: RefObject<Puzzle | null>,
  notify: (tone: "error", text: string) => void,
) {
  const [meta, setMeta] = useState<DayMeta>(EMPTY_META);
  const metaRef = useRef(meta);

  // One saver per puzzle, so switching puzzles never drops the previous one's unsaved changes.
  const metaSavers = useRef(new Map<string, LatestSaver<DayMeta>>());
  const saveMetaSoon = useCallback(({ p, m }: { p: Puzzle; m: DayMeta }) => {
    const key = `${p.year}-${p.day}`;
    let saver = metaSavers.current.get(key);
    if (!saver) {
      saver = new LatestSaver<DayMeta>(
        (meta, keepalive) => api.saveMeta(p, meta, keepalive),
        600,
        (e) => notify("error", `Couldn't save, retrying: ${e}`),
      );
      metaSavers.current.set(key, saver);
    }
    saver.schedule(m);
  }, []);
  const updateMeta = useCallback(
    (next: DayMeta) => {
      metaRef.current = next;
      setMeta(next);
      if (puzzleRef.current) saveMetaSoon({ p: puzzleRef.current, m: next });
    },
    [saveMetaSoon],
  );

  return { meta, setMeta, metaRef, metaSavers, updateMeta };
}
