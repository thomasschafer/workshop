import type { VNode } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Opened, Round } from "./types";

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

vi.mock("../hooks/useConnection", () => ({
  useConnection: () => true,
}));

const mocks = vi.hoisted(() => {
  if (typeof globalThis.window === "undefined") {
    (globalThis as unknown as { window: unknown }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }
  return {
    end: vi.fn(),
    beat: vi.fn(async () => ({ clock: { used_ms: 0, remaining_ms: 600_000 }, ended: null })),
    say: vi.fn(),
  };
});

vi.mock("./api", () => ({
  roundsApi: {
    end: mocks.end,
    beat: mocks.beat,
    say: mocks.say,
  },
}));

import { RoundView } from "./screen";

function findVNode(
  node: unknown,
  predicate: (vnode: VNode<Record<string, unknown>>) => boolean,
): VNode<Record<string, unknown>> | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findVNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object" && "type" in node && "props" in node) {
    const vnode = node as VNode<Record<string, unknown>>;
    if (predicate(vnode)) return vnode;
    return findVNode(vnode.props?.children, predicate);
  }
  return null;
}

describe("RoundView marking error display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookState.slots = [];
    hookState.effects = [];
    hookState.pendingEffects = [];
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the marking error alert when End and mark it fails during an active round", async () => {
    mocks.end.mockRejectedValueOnce(new Error("model timed out"));

    const opened: Opened = {
      key: "sample/two-dice-seven",
      kind: "probability",
      label: "Two fair dice",
      prompt: "Find the probability.",
      source: null,
      examples: [],
      api: null,
      minutes: 10,
      styles: [],
      round: null,
    };
    const round: Round = {
      style: null,
      clock: { used_ms: 0, remaining_ms: 600_000 },
      work: "",
      turns: [],
      returned: false,
      ended: null,
    };

    let tree: unknown;
    const render = () => {
      hookState.cursor = 0;
      hookState.effectCursor = 0;
      tree = RoundView({
        opened,
        round,
        serverDictation: false,
        onDone: () => {},
      });
    };
    hookState.rerender = render;
    render();

    const endBtn = findVNode(
      tree,
      (v) => v.type === "button" && v.props.children === "End and mark it",
    );
    if (!endBtn || typeof endBtn.props.onClick !== "function") {
      throw new Error("expected End and mark it button");
    }

    (endBtn.props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();

    const alert = findVNode(tree, (v) => v.props.role === "alert");
    expect(alert).not.toBeNull();
    expect(alert?.props.children).toBe("model timed out");
  });
});
