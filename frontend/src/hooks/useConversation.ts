import { useEffect, useRef, useState } from "preact/hooks";
import { followReply, ReplyLost, type Turn } from "../api";
import { errorMessage } from "../errors";
import { newId } from "../learning/local";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or disabled; the conversation still works for this visit.
  }
}

/** Where the reply being waited for is kept, by its id, so it's picked up after a reload. */
const pendingKey = (key: string) => `${key}:pending`;

/** How long to wait before each attempt to pick a lost reply up again, while the page is shown. */
const FOLLOW_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** Waits `ms`, then until the page is shown, as a hidden page's requests are often cut off. */
async function shownAfter(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  if (document.visibilityState === "visible") return;
  await new Promise<void>((resolve) => {
    const shown = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", shown);
      resolve();
    };
    document.addEventListener("visibilitychange", shown);
  });
}

/**
 * Asks the coach to reply to the conversation, keeping the reply on the server as `replyId`, and
 * handing over its text as it's written.
 */
export type Ask = (
  turns: Turn[],
  replyId: string,
  onDelta: (text: string) => void,
) => Promise<{ text: string }>;

/**
 * A conversation with a coach, kept on this device under `storageKey`, or none while there's
 * nothing to talk about. A new key starts the conversation kept for it.
 *
 * A reply whose connection is lost, as when the phone's put down or the app's left part-way
 * through, is picked up again from the server once the page is shown, even after a reload.
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
  /** The reply being waited for; one that's been replaced or let go of changes nothing. */
  const waiting = useRef<symbol | null>(null);

  const update = (key: string, next: Turn[]) => {
    turnsRef.current = next;
    setTurns(next);
    save(key, next.length > 0 ? next : null);
  };

  /** Waits for reply `id` to `turns`, asked for by `first`, picking it up again if it's lost. */
  const waitForReply = async (
    key: string,
    turns: Turn[],
    id: string,
    first: ((onDelta: (text: string) => void) => Promise<{ text: string }>) | null,
  ) => {
    const token = Symbol(id);
    waiting.current = token;
    const current = () => waiting.current === token && keyRef.current === key;
    const onDelta = (text: string) => {
      if (current()) setPartial((sofar) => sofar + text);
    };
    save(pendingKey(key), id);
    setThinking(true);
    setPartial("");
    setError(null);
    let failure: string | null = null;
    try {
      let reply: { text: string } | null = null;
      if (first) {
        try {
          reply = await first(onDelta);
        } catch (e) {
          if (!(e instanceof ReplyLost)) throw e;
        }
      }
      for (const delay of FOLLOW_DELAYS_MS) {
        if (reply || !current()) break;
        await shownAfter(delay);
        if (!current()) break;
        // Picked up from the start, so what arrived before is written again.
        setPartial("");
        try {
          reply = await followReply(id, onDelta);
        } catch (e) {
          if (!(e instanceof ReplyLost)) throw e;
        }
      }
      if (!current()) return;
      if (!reply) throw new Error("Lost the connection to the coach before it replied.");
      update(key, [...turns, { speaker: "coach", text: reply.text }]);
    } catch (e) {
      failure = errorMessage(e);
    }
    if (!current()) return;
    waiting.current = null;
    save(pendingKey(key), null);
    setError(failure);
    setThinking(false);
    setPartial("");
  };

  useEffect(() => {
    keyRef.current = storageKey;
    waiting.current = null;
    const loaded = storageKey ? load<Turn[]>(storageKey, []) : [];
    turnsRef.current = loaded;
    setTurns(loaded);
    setThinking(false);
    setPartial("");
    setError(null);
    setDraft("");
    // A reply that was still coming when the conversation was last open.
    const pending = storageKey ? load<string | null>(pendingKey(storageKey), null) : null;
    if (storageKey && pending) {
      if (loaded.at(-1)?.speaker === "user") void waitForReply(storageKey, loaded, pending, null);
      else save(pendingKey(storageKey), null);
    }
  }, [storageKey]);

  /** Asks for a reply to the conversation as it is. */
  const askNow = (key: string, turns: Turn[]) => {
    const id = newId();
    return waitForReply(key, turns, id, (onDelta) => askRef.current(turns, id, onDelta));
  };

  const send = async (text: string) => {
    const key = keyRef.current;
    if (!key) {
      setError(nothing);
      return;
    }
    const next: Turn[] = [...turnsRef.current, { speaker: "user", text }];
    update(key, next);
    await askNow(key, next);
  };

  /** Asks again for a reply to the last message, which has none. */
  const retry = async () => {
    const key = keyRef.current;
    if (!key || waiting.current || turnsRef.current.at(-1)?.speaker !== "user") return;
    await askNow(key, turnsRef.current);
  };

  const clear = () => {
    const key = keyRef.current;
    if (!key) return;
    waiting.current = null;
    save(pendingKey(key), null);
    setThinking(false);
    setPartial("");
    setError(null);
    update(key, []);
  };

  const unanswered = !thinking && turns.at(-1)?.speaker === "user";
  return { turns, thinking, partial, error, unanswered, draft, setDraft, send, retry, clear };
}

export type Conversation = ReturnType<typeof useConversation>;
