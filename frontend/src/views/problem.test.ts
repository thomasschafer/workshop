import type { VNode } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DayMeta, Problem, Puzzle } from "../api";

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
  useLayoutEffect() {},
}));

const mocks = vi.hoisted(() => ({
  input: vi.fn(),
  getAocPuzzle: vi.fn(async () => undefined),
  mergeAocPuzzle: vi.fn(async () => {}),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { ...actual.api, input: mocks.input },
  };
});

vi.mock("../offline/db", () => ({
  getAocPuzzle: mocks.getAocPuzzle,
  mergeAocPuzzle: mocks.mergeAocPuzzle,
}));

import { ProblemView, PuzzleInput } from "./problem";

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

function emptyMeta(): DayMeta {
  return {
    sample_blocks: [null, null],
    sample_inputs: [null, null],
    sample_answers: [null, null],
    cursor: 0,
    version: 0,
  };
}

function sampleProblem(title: string): Problem {
  return {
    title,
    parts_html: ['<pre data-block="0">1\n2\n</pre>'],
    text: "1\n2\n",
    answers: [],
    stars: 0,
    final_star: null,
    suggested_sample_answers: [null, null],
    suggested_sample_blocks: [null, null],
    blocks: ["1\n2\n"],
  };
}

function flushEffects() {
  const pending = hookState.pendingEffects.splice(0);
  for (const i of pending) {
    const entry = hookState.effects[i];
    if (!entry) continue;
    entry.cleanup?.();
    entry.cleanup = entry.fn();
  }
}

describe("ProblemView and PuzzleInput puzzle switch handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookState.slots = [];
    hookState.effects = [];
    hookState.pendingEffects = [];
  });

  it("closes the sample chooser when switching to another puzzle", () => {
    let puzzle: Puzzle = { year: 2024, day: 1 };
    let problem = sampleProblem("Day 1");
    let tree: unknown;
    const render = () => {
      hookState.cursor = 0;
      hookState.effectCursor = 0;
      tree = ProblemView({
        puzzle,
        problem,
        error: null,
        loading: false,
        meta: emptyMeta(),
        onMeta: () => {},
        onRefresh: () => {},
        onStartAgain: null,
        findingSamples: [],
        hidden: false,
      });
      flushEffects();
    };
    hookState.rerender = render;
    render();

    const partsWrap = findVNode(
      tree,
      (v) => v.type === "div" && typeof v.props.onClick === "function",
    );
    if (!partsWrap || typeof partsWrap.props.onClick !== "function") {
      throw new Error("expected puzzle parts wrapper with onClick handler");
    }
    // Simulate tapping a code block in Day 1 to open the sticky chooser.
    const fakePre = {
      dataset: { block: "0" },
      textContent: "1\n2\n",
      closest: (sel: string) =>
        sel === "[data-part]"
          ? { dataset: { part: "0" } }
          : sel === "pre[data-block]"
            ? fakePre
            : null,
    };
    (partsWrap.props.onClick as (e: { target: unknown }) => void)({ target: fakePre });
    expect(findVNode(tree, (v) => v.props.class === "chooser")).not.toBeNull();

    // Switch to Day 2: chooser must close so Day 1's sample cannot be saved into Day 2.
    puzzle = { year: 2024, day: 2 };
    problem = sampleProblem("Day 2");
    render();
    expect(findVNode(tree, (v) => v.props.class === "chooser")).toBeNull();
  });

  it("drops an in-flight puzzle input fetch when switching to another puzzle", async () => {
    let resolveInput!: (value: { text: string; lines: number }) => void;
    mocks.input.mockReturnValueOnce(
      new Promise<{ text: string; lines: number }>((res) => {
        resolveInput = res;
      }),
    );

    let puzzle: Puzzle = { year: 2024, day: 1 };
    let tree: unknown;
    const render = () => {
      hookState.cursor = 0;
      hookState.effectCursor = 0;
      tree = PuzzleInput({ puzzle });
      flushEffects();
    };
    hookState.rerender = render;
    render();

    const showBtn = findVNode(tree, (v) => v.type === "button");
    if (!showBtn || typeof showBtn.props.onClick !== "function") {
      throw new Error("expected Show your puzzle input button");
    }
    (showBtn.props.onClick as () => void)();

    // Switch to Day 2 while Day 1's input request is still pending.
    puzzle = { year: 2024, day: 2 };
    render();

    // Resolve Day 1's input fetch: Day 2 must stay hidden rather than showing Day 1's input.
    resolveInput({ text: "DAY1-INPUT\n", lines: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(findVNode(tree, (v) => v.props.class === "input-text")).toBeNull();
  });
});
