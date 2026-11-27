import { Compartment } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

interface HookSlot {
  value: unknown;
}

const hookState = {
  slots: [] as HookSlot[],
  cursor: 0,
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
  useCallback<T>(fn: T) {
    return fn;
  },
}));

import { CodeEditor } from "../editor";
import { type CodeKeyboardState, useCodeKeyboard } from "./useCodeKeyboard";

describe("useCodeKeyboard", () => {
  it("only invokes reveal when showing the keyboard, not when hiding it", () => {
    hookState.slots = [];
    const setKeyboard = vi.fn();
    const setStatusHost = vi.fn();
    const editorRef = {
      current: { setKeyboard, setStatusHost } as unknown as CodeEditor,
    };
    const reveal = vi.fn();
    let state!: CodeKeyboardState;
    const render = () => {
      hookState.cursor = 0;
      state = useCodeKeyboard(editorRef, reveal);
    };
    hookState.rerender = render;
    render();

    state.show(true);
    expect(state.wanted).toBe(true);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(setKeyboard).toHaveBeenLastCalledWith(true);

    state.show(false);
    expect(state.wanted).toBe(false);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(setKeyboard).toHaveBeenLastCalledWith(false);
  });
});

describe("CodeEditor.setKeyboard", () => {
  it("blurs the editor contentDOM when hiding the keyboard so iOS dismisses it", () => {
    const blur = vi.fn();
    const focus = vi.fn();
    const dispatch = vi.fn();
    const fakeEditor = {
      inputMode: new Compartment(),
      view: {
        dispatch,
        focus,
        contentDOM: { blur },
        plugin: () => null,
      },
    };

    CodeEditor.prototype.setKeyboard.call(fakeEditor, true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(blur).not.toHaveBeenCalled();

    CodeEditor.prototype.setKeyboard.call(fakeEditor, false);
    expect(blur).toHaveBeenCalledTimes(1);
  });
});
