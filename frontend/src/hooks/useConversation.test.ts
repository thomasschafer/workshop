import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Turn } from "../api";

// Minimal Preact hook harness so useConversation can be tested directly in Vitest's node runtime.
interface HookSlot {
  value: unknown;
}
interface EffectEntry {
  deps: unknown[] | undefined;
  fn: () => undefined | (() => void);
  cleanup: (() => void) | undefined;
}

const hookState = {
  slots: [] as HookSlot[],
  effects: [] as EffectEntry[],
  pendingEffects: [] as number[],
  cursor: 0,
  effectCursor: 0,
  rerender: () => {},
};

function slotAt(index: number): HookSlot {
  const slot = hookState.slots[index];
  if (!slot) throw new Error(`missing hook slot ${index}`);
  return slot;
}

vi.mock("preact/hooks", () => ({
  useState<T>(initial: T | (() => T)) {
    const index = hookState.cursor++;
    if (index >= hookState.slots.length) {
      const value = typeof initial === "function" ? (initial as () => T)() : initial;
      hookState.slots.push({ value });
    }
    const set = (next: T | ((prev: T) => T)) => {
      const slot = slotAt(index);
      const prev = slot.value as T;
      const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (!Object.is(prev, value)) {
        slot.value = value;
        hookState.rerender();
      }
    };
    return [slotAt(index).value as T, set] as const;
  },
  useRef<T>(initial: T) {
    const index = hookState.cursor++;
    if (index >= hookState.slots.length) {
      hookState.slots.push({ value: { current: initial } });
    }
    return slotAt(index).value as { current: T };
  },
  useEffect(fn: () => undefined | (() => void), deps?: unknown[]) {
    const index = hookState.effectCursor++;
    const prev = hookState.effects[index];
    const changed =
      !prev ||
      !deps ||
      !prev.deps ||
      deps.length !== prev.deps.length ||
      deps.some((d, i) => !Object.is(d, prev.deps?.[i]));
    if (changed) {
      hookState.effects[index] = { deps, fn, cleanup: prev?.cleanup };
      hookState.pendingEffects.push(index);
    }
  },
}));

const apiMocks = vi.hoisted(() => ({
  cancelReply: vi.fn(async (_id: string) => null),
  followReply: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    cancelReply: apiMocks.cancelReply,
    followReply: apiMocks.followReply,
  };
});

import { type Ask, type Conversation, useConversation } from "./useConversation";

function mount(storageKey: string | null, ask: Ask, onReply?: () => void) {
  hookState.slots = [];
  hookState.effects = [];
  hookState.pendingEffects = [];
  let currentKey = storageKey;
  let currentAsk = ask;
  const currentOnReply = onReply;
  let result!: Conversation;

  const render = () => {
    hookState.cursor = 0;
    hookState.effectCursor = 0;
    result = useConversation(currentKey, currentAsk, "Nothing open.", currentOnReply);
    const pending = hookState.pendingEffects.splice(0);
    for (const i of pending) {
      const entry = hookState.effects[i];
      if (!entry) continue;
      entry.cleanup?.();
      const cleanup = entry.fn();
      entry.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
  };
  hookState.rerender = render;
  render();

  return {
    get current() {
      return result;
    },
    setKey(next: string | null) {
      currentKey = next;
      render();
    },
    setAsk(next: Ask) {
      currentAsk = next;
      render();
    },
    unmount() {
      for (const entry of hookState.effects) entry.cleanup?.();
      hookState.effects = [];
      hookState.slots = [];
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useConversation cancellation", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    apiMocks.cancelReply.mockClear();
    apiMocks.followReply.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts, tells the server, restores the question to draft, and ignores late deltas or replies", async () => {
    const captured: {
      replyId: string;
      signal: AbortSignal | null;
      onDelta: ((text: string) => void) | null;
    } = { replyId: "", signal: null, onDelta: null };
    const reply = deferred<{ text: string }>();
    const onReply = vi.fn();

    const hook = mount(
      "conv:1",
      (_turns, replyId, onDelta, signal) => {
        captured.replyId = replyId;
        captured.signal = signal;
        captured.onDelta = onDelta;
        return reply.promise;
      },
      onReply,
    );

    const sending = hook.current.send("Why does my loop hang?");
    expect(hook.current.thinking).toBe(true);
    expect(hook.current.turns).toEqual([{ speaker: "user", text: "Why does my loop hang?" }]);
    expect(store.get("conv:1:pending")).toBe(JSON.stringify(captured.replyId));

    captured.onDelta?.("Check the ");
    expect(hook.current.partial).toBe("Check the ");

    // Cancel while the coach is still streaming.
    hook.current.cancel();
    expect(captured.signal?.aborted).toBe(true);
    expect(apiMocks.cancelReply).toHaveBeenCalledWith(captured.replyId);
    expect(store.get("conv:1:pending")).toBeUndefined();
    expect(hook.current.thinking).toBe(false);
    expect(hook.current.partial).toBe("");
    expect(hook.current.error).toBeNull();
    expect(hook.current.turns).toEqual([]);
    expect(hook.current.draft).toBe("Why does my loop hang?");

    // Even if the in-flight request ignores AbortSignal and delivers a late delta and reply,
    // nothing changes and no hint/reply callback runs.
    captured.onDelta?.("late delta");
    reply.resolve({ text: "Late coach reply" });
    expect(await sending).toBe("cancelled");
    expect(hook.current.turns).toEqual([]);
    expect(hook.current.partial).toBe("");
    expect(hook.current.thinking).toBe(false);
    expect(hook.current.error).toBeNull();
    expect(onReply).not.toHaveBeenCalled();
    expect(apiMocks.followReply).not.toHaveBeenCalled();

    hook.unmount();
  });

  it("prepends the cancelled question before text already typed into the draft", async () => {
    const reply = deferred<{ text: string }>();
    const hook = mount("conv:2", () => reply.promise);

    const sending = hook.current.send("First question");
    hook.current.setDraft("follow-up thought");
    hook.current.cancel();

    expect(hook.current.draft).toBe("First question\nfollow-up thought");
    expect(hook.current.turns).toEqual([]);

    reply.reject(new DOMException("Aborted", "AbortError"));
    expect(await sending).toBe("cancelled");
    hook.unmount();
  });

  it("cancels a reply resumed after a reload and restores the trailing user turn", async () => {
    const existingTurns: Turn[] = [
      { speaker: "user", text: "Earlier question" },
      { speaker: "coach", text: "Earlier answer" },
      { speaker: "user", text: "Reloaded question" },
    ];
    store.set("conv:3", JSON.stringify(existingTurns));
    store.set("conv:3:pending", JSON.stringify("reply-before-reload"));

    const captured: { signal: AbortSignal | null } = { signal: null };
    const follow = deferred<{ text: string }>();
    apiMocks.followReply.mockImplementation(
      (_id: string, _onDelta: (t: string) => void, signal?: AbortSignal) => {
        captured.signal = signal ?? null;
        return follow.promise;
      },
    );

    const hook = mount("conv:3", async () => {
      throw new Error("should follow, not ask");
    });
    // Let shownAfter(0) yield to followReply.
    await Promise.resolve();
    await Promise.resolve();

    expect(hook.current.thinking).toBe(true);
    expect(apiMocks.followReply).toHaveBeenCalledOnce();

    hook.current.cancel();
    expect(captured.signal?.aborted).toBe(true);
    expect(apiMocks.cancelReply).toHaveBeenCalledWith("reply-before-reload");
    expect(store.get("conv:3:pending")).toBeUndefined();
    expect(hook.current.thinking).toBe(false);
    expect(hook.current.draft).toBe("Reloaded question");
    expect(hook.current.turns).toEqual(existingTurns.slice(0, 2));

    follow.resolve({ text: "Too late" });
    await Promise.resolve();
    expect(hook.current.turns).toEqual(existingTurns.slice(0, 2));
    hook.unmount();
  });

  it("calls onReply only once a reply actually arrives", async () => {
    const onReply = vi.fn();
    const hook = mount(
      "conv:4",
      async (_turns, _id, onDelta) => {
        onDelta("Here is a hint.");
        return { text: "Here is a hint." };
      },
      onReply,
    );

    expect(await hook.current.send("Give me a hint")).toBe("replied");
    expect(onReply).toHaveBeenCalledOnce();
    expect(hook.current.turns).toEqual([
      { speaker: "user", text: "Give me a hint" },
      { speaker: "coach", text: "Here is a hint." },
    ]);
    hook.unmount();
  });
});
