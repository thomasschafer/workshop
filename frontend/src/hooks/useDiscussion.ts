import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Puzzle, type Turn } from "../api";

const storageKey = (p: Puzzle) => `workshop:discuss:${p.year}:${p.day}`;

function loadTurns(p: Puzzle): Turn[] {
  try {
    const raw = localStorage.getItem(storageKey(p));
    return raw ? (JSON.parse(raw) as Turn[]) : [];
  } catch {
    return [];
  }
}

function saveTurns(p: Puzzle, turns: Turn[]): void {
  try {
    if (turns.length === 0) localStorage.removeItem(storageKey(p));
    else localStorage.setItem(storageKey(p), JSON.stringify(turns));
  } catch {
    // Storage can be full or disabled; the conversation still works for this visit.
  }
}

/** What the discussion model is shown alongside the conversation. */
export interface DiscussContext {
  code: string;
  errors: string;
  lastRun: string;
}

/** A conversation about the current puzzle, kept per puzzle on this device. */
export function useDiscussion(puzzle: Puzzle | null, model: string, context: () => DiscussContext) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thinking, setThinking] = useState(false);
  /** The reply so far, while it's being written. */
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Utterances are queued, so a send can start before a re-render; these always hold the latest.
  const turnsRef = useRef(turns);
  const puzzleRef = useRef(puzzle);

  const update = (p: Puzzle, next: Turn[]) => {
    turnsRef.current = next;
    setTurns(next);
    saveTurns(p, next);
  };

  useEffect(() => {
    puzzleRef.current = puzzle;
    const loaded = puzzle ? loadTurns(puzzle) : [];
    turnsRef.current = loaded;
    setTurns(loaded);
    setError(null);
  }, [puzzle]);

  const send = async (text: string) => {
    const p = puzzleRef.current;
    if (!p) {
      setError("Open a puzzle before discussing it.");
      return;
    }
    const next: Turn[] = [...turnsRef.current, { speaker: "user", text }];
    update(p, next);
    setThinking(true);
    setPartial("");
    setError(null);
    const { code, errors, lastRun } = context();
    try {
      const reply = await api.discuss(
        {
          year: p.year,
          day: p.day,
          model,
          turns: next,
          code,
          errors,
          last_run: lastRun,
        },
        (text) => {
          if (puzzleRef.current === p) setPartial((sofar) => sofar + text);
        },
      );
      if (puzzleRef.current !== p) return;
      update(p, [...next, { speaker: "coach", text: reply.text }]);
    } catch (e) {
      if (puzzleRef.current === p) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setThinking(false);
      setPartial("");
    }
  };

  const clear = () => {
    const p = puzzleRef.current;
    if (p) update(p, []);
  };

  return { turns, thinking, partial, error, send, clear };
}
