import type { RefObject } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, api, type DayMeta, type Puzzle } from "../api";
import { mergeAocPuzzle } from "../offline/db";
import { EMPTY_META } from "../samples";
import { LatestSaver } from "../saver";

function sameSamples(a: DayMeta, b: DayMeta): boolean {
  return (
    a.sample_blocks[0] === b.sample_blocks[0] &&
    a.sample_blocks[1] === b.sample_blocks[1] &&
    a.sample_inputs[0] === b.sample_inputs[0] &&
    a.sample_inputs[1] === b.sample_inputs[1] &&
    a.sample_answers[0] === b.sample_answers[0] &&
    a.sample_answers[1] === b.sample_answers[1]
  );
}

/**
 * What's kept for the open puzzle besides its code and notes, such as the chosen sample and the
 * cursor, saved shortly after each change with monotonic version checks and IndexedDB caching.
 */
export function useDayMeta(
  puzzleRef: RefObject<Puzzle | null>,
  notify: (tone: "info" | "error", text: string) => void,
) {
  const [meta, setMeta] = useState<DayMeta>(EMPTY_META);
  const metaRef = useRef(meta);

  // Per-puzzle confirmed state from the server so sequential saves send the latest version and
  // conflicts can tell whether samples or only the cursor changed.
  const confirmedRef = useRef(new Map<string, DayMeta>());
  // One saver per puzzle, so switching puzzles never drops the previous one's unsaved changes.
  const metaSavers = useRef(new Map<string, LatestSaver<DayMeta>>());

  const initMeta = useCallback((p: Puzzle, loaded: DayMeta) => {
    const key = `${p.year}-${p.day}`;
    confirmedRef.current.set(key, loaded);
    metaRef.current = loaded;
    setMeta(loaded);
  }, []);

  const saveMetaSoon = useCallback(({ p, m }: { p: Puzzle; m: DayMeta }) => {
    const key = `${p.year}-${p.day}`;
    let saver = metaSavers.current.get(key);
    if (!saver) {
      saver = new LatestSaver<DayMeta>(
        async (next, keepalive) => {
          const base = confirmedRef.current.get(key);
          const toSend: DayMeta = { ...next, version: base?.version ?? next.version };
          try {
            const saved = await api.saveMeta(p, toSend, keepalive);
            confirmedRef.current.set(key, saved);
            void mergeAocPuzzle(p.year, p.day, { meta: saved });
            if (puzzleRef.current?.year === p.year && puzzleRef.current?.day === p.day) {
              const updated: DayMeta = { ...metaRef.current, version: saved.version };
              metaRef.current = updated;
              setMeta(updated);
            }
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
              const current = (err.body as { current?: DayMeta } | null)?.current;
              if (current) {
                confirmedRef.current.set(key, current);
                // If only the cursor moved locally, rebase it onto the server's latest samples.
                if (base && sameSamples(next, base)) {
                  const rebased: DayMeta = { ...current, cursor: next.cursor };
                  const saved = await api.saveMeta(p, rebased, keepalive);
                  confirmedRef.current.set(key, saved);
                  void mergeAocPuzzle(p.year, p.day, { meta: saved });
                  if (puzzleRef.current?.year === p.year && puzzleRef.current?.day === p.day) {
                    metaRef.current = saved;
                    setMeta(saved);
                  }
                  return;
                }
                void mergeAocPuzzle(p.year, p.day, { meta: current });
                if (puzzleRef.current?.year === p.year && puzzleRef.current?.day === p.day) {
                  metaRef.current = current;
                  setMeta(current);
                }
                notify("info", "Puzzle settings changed elsewhere; loaded the latest.");
                return;
              }
            }
            throw err;
          }
        },
        600,
        (e) => notify("error", `Couldn't save, retrying: ${e}`),
        { pauseWhileOffline: true },
      );
      metaSavers.current.set(key, saver);
    }
    saver.schedule(m);
  }, []);

  const updateMeta = useCallback(
    (next: DayMeta) => {
      metaRef.current = next;
      setMeta(next);
      const p = puzzleRef.current;
      if (p) {
        void mergeAocPuzzle(p.year, p.day, { meta: next });
        saveMetaSoon({ p, m: next });
      }
    },
    [saveMetaSoon],
  );

  useEffect(() => {
    return () => {
      for (const saver of metaSavers.current.values()) saver.close();
      metaSavers.current.clear();
    };
  }, []);

  return { meta, setMeta, initMeta, metaRef, metaSavers, updateMeta };
}
