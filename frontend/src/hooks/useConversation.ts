import { useEffect, useRef, useState } from "preact/hooks";
import type { Turn } from "../api";

function loadTurns(key: string): Turn[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Turn[]) : [];
  } catch {
    return [];
  }
}

function saveTurns(key: string, turns: Turn[]): void {
  try {
    if (turns.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(turns));
  } catch {
    // Storage can be full or disabled; the conversation still works for this visit.
  }
}

/** Asks the coach to reply to the conversation, handing over its reply as it's written. */
export type Ask = (turns: Turn[], onDelta: (text: string) => void) => Promise<{ text: string }>;

/**
 * A conversation with a coach, kept on this device under `storageKey`, or none while there's
 * nothing to talk about. A new key starts the conversation kept for it.
 */
export function useConversation(storageKey: string | null, ask: Ask, nothing: string) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thinking, setThinking] = useState(false);
  /** The reply so far, while it's being written. */
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** A question being typed, kept here so it survives the conversation's view closing. */
  const [draft, setDraft] = useState("");
  // Utterances are queued, so a send can start before a re-render; these always hold the latest.
  const turnsRef = useRef(turns);
  const keyRef = useRef(storageKey);
  const askRef = useRef(ask);
  askRef.current = ask;

  const update = (key: string, next: Turn[]) => {
    turnsRef.current = next;
    setTurns(next);
    saveTurns(key, next);
  };

  useEffect(() => {
    keyRef.current = storageKey;
    const loaded = storageKey ? loadTurns(storageKey) : [];
    turnsRef.current = loaded;
    setTurns(loaded);
    setError(null);
    setDraft("");
  }, [storageKey]);

  const send = async (text: string) => {
    const key = keyRef.current;
    if (!key) {
      setError(nothing);
      return;
    }
    const next: Turn[] = [...turnsRef.current, { speaker: "user", text }];
    update(key, next);
    setThinking(true);
    setPartial("");
    setError(null);
    try {
      const reply = await askRef.current(next, (text) => {
        if (keyRef.current === key) setPartial((sofar) => sofar + text);
      });
      if (keyRef.current !== key) return;
      update(key, [...next, { speaker: "coach", text: reply.text }]);
    } catch (e) {
      if (keyRef.current === key) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setThinking(false);
      setPartial("");
    }
  };

  const clear = () => {
    const key = keyRef.current;
    if (key) update(key, []);
  };

  return { turns, thinking, partial, error, draft, setDraft, send, clear };
}

export type Conversation = ReturnType<typeof useConversation>;
