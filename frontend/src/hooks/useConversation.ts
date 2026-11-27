import { useEffect, useRef, useState } from "preact/hooks";
import { cancelReply, followReply, ReplyCancelled, ReplyLost, type Turn } from "../api";
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
async function shownAfter(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  if (ms > 0) {
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  if (signal.aborted || document.visibilityState === "visible") return;
  await new Promise<void>((resolve) => {
    const shown = () => {
      if (document.visibilityState !== "visible") return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      document.removeEventListener("visibilitychange", shown);
      signal.removeEventListener("abort", onAbort);
    };
    document.addEventListener("visibilitychange", shown);
    signal.addEventListener("abort", onAbort, { once: true });
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
  signal: AbortSignal,
) => Promise<{ text: string }>;

export type SendOutcome = "replied" | "cancelled" | "failed";

/**
 * A conversation with a coach, kept on this device under `storageKey`, or none while there's
 * nothing to talk about. A new key starts the conversation kept for it.
 *
 * A reply whose connection is lost, as when the phone's put down or the app's left part-way
 * through, is picked up again from the server once the page is shown, even after a reload.
 */
export function useConversation(
  storageKey: string | null,
  ask: Ask,
  nothing: string,
  onReply?: () => void,
) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thinking, setThinking] = useState(false);
  /** The reply so far, while it's being written. */
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** A question being typed, kept here so it survives the conversation's view closing. */
  const [draft, setDraftState] = useState("");
  // Utterances are queued, so a send can start before a re-render; these always hold the latest.
  const turnsRef = useRef(turns);
  const draftRef = useRef(draft);
  const keyRef = useRef(storageKey);
  const askRef = useRef(ask);
  askRef.current = ask;
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;
  /** The reply being waited for; one that's been replaced or let go of changes nothing. */
  const activeRef = useRef<{ token: symbol; id: string; controller: AbortController } | null>(null);

  const setDraft = (next: string) => {
    draftRef.current = next;
    setDraftState(next);
  };

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
    first:
      | ((onDelta: (text: string) => void, signal: AbortSignal) => Promise<{ text: string }>)
      | null,
  ): Promise<SendOutcome> => {
    activeRef.current?.controller.abort();
    const token = Symbol(id);
    const controller = new AbortController();
    activeRef.current = { token, id, controller };
    const current = () => activeRef.current?.token === token && keyRef.current === key;
    const onDelta = (text: string) => {
      if (current()) setPartial((sofar) => sofar + text);
    };
    save(pendingKey(key), id);
    setThinking(true);
    setPartial("");
    setError(null);
    let failure: string | null = null;
    let outcome: SendOutcome = "failed";
    try {
      let reply: { text: string } | null = null;
      if (first) {
        try {
          reply = await first(onDelta, controller.signal);
        } catch (e) {
          if (!(e instanceof ReplyLost)) throw e;
        }
      }
      for (const delay of FOLLOW_DELAYS_MS) {
        if (reply || !current()) break;
        await shownAfter(delay, controller.signal);
        if (!current()) break;
        // Picked up from the start, so what arrived before is written again.
        setPartial("");
        try {
          reply = await followReply(id, onDelta, controller.signal);
        } catch (e) {
          if (!(e instanceof ReplyLost)) throw e;
        }
      }
      if (!current()) return "cancelled";
      if (!reply) throw new Error("Lost the connection to the coach before it replied.");
      update(key, [...turns, { speaker: "coach", text: reply.text }]);
      onReplyRef.current?.();
      outcome = "replied";
    } catch (e) {
      if (!current()) return "cancelled";
      if (e instanceof ReplyCancelled) {
        outcome = "cancelled";
      } else {
        failure = errorMessage(e);
      }
    }
    if (!current()) return "cancelled";
    activeRef.current = null;
    save(pendingKey(key), null);
    setError(failure);
    setThinking(false);
    setPartial("");
    return outcome;
  };

  useEffect(() => {
    keyRef.current = storageKey;
    activeRef.current?.controller.abort();
    activeRef.current = null;
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
    return () => {
      activeRef.current?.controller.abort();
      activeRef.current = null;
    };
  }, [storageKey]);

  /** Asks for a reply to the conversation as it is. */
  const askNow = (key: string, turns: Turn[]) => {
    const id = newId();
    return waitForReply(key, turns, id, (onDelta, signal) =>
      askRef.current(turns, id, onDelta, signal),
    );
  };

  const send = async (text: string): Promise<SendOutcome> => {
    const key = keyRef.current;
    if (!key) {
      setError(nothing);
      return "failed";
    }
    const next: Turn[] = [...turnsRef.current, { speaker: "user", text }];
    update(key, next);
    return askNow(key, next);
  };

  /** Asks again for a reply to the last message, which has none. */
  const retry = async () => {
    const key = keyRef.current;
    if (!key || activeRef.current || turnsRef.current.at(-1)?.speaker !== "user") return;
    await askNow(key, turnsRef.current);
  };

  /** Stops the reply in progress and returns the unanswered question to the input box. */
  const cancel = () => {
    const key = keyRef.current;
    const active = activeRef.current;
    if (!key || !active) return;
    activeRef.current = null;
    save(pendingKey(key), null);
    active.controller.abort();
    cancelReply(active.id).catch(() => {});
    const currentTurns = turnsRef.current;
    const last = currentTurns.at(-1);
    if (last?.speaker === "user") {
      update(key, currentTurns.slice(0, -1));
      const existing = draftRef.current;
      setDraft(existing ? `${last.text}\n${existing}` : last.text);
    }
    setThinking(false);
    setPartial("");
    setError(null);
  };

  const clear = () => {
    const key = keyRef.current;
    if (!key) return;
    const active = activeRef.current;
    activeRef.current = null;
    if (active) {
      active.controller.abort();
      cancelReply(active.id).catch(() => {});
    }
    save(pendingKey(key), null);
    setThinking(false);
    setPartial("");
    setError(null);
    update(key, []);
  };

  const unanswered = !thinking && turns.at(-1)?.speaker === "user";
  return {
    turns,
    thinking,
    partial,
    error,
    unanswered,
    draft,
    setDraft,
    send,
    cancel,
    retry,
    clear,
  };
}

export type Conversation = ReturnType<typeof useConversation>;
