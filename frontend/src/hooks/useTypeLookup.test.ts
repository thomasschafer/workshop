import type { LSPClient } from "@codemirror/lsp-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeEditor } from "../editor";

interface HookSlot {
  value: unknown;
}

const hookState = {
  slots: [] as HookSlot[],
  cursor: 0,
};

function slotAt(index: number): HookSlot {
  const slot = hookState.slots[index];
  if (!slot) throw new Error(`missing hook slot ${index}`);
  return slot;
}

vi.mock("preact/hooks", () => ({
  useRef<T>(initial: T) {
    const index = hookState.cursor++;
    if (index >= hookState.slots.length) {
      hookState.slots.push({ value: { current: initial } });
    }
    return slotAt(index).value as { current: T };
  },
  useMemo<T>(factory: () => T, deps: unknown[]) {
    const index = hookState.cursor++;
    const prev = hookState.slots[index]?.value as { value: T; deps: unknown[] } | undefined;
    if (
      !prev ||
      deps.length !== prev.deps.length ||
      deps.some((d, i) => !Object.is(d, prev.deps[i]))
    ) {
      const value = factory();
      hookState.slots[index] = { value: { value, deps } };
      return value;
    }
    return prev.value;
  },
}));

const mocks = vi.hoisted(() => ({
  hoverText: vi.fn(),
}));

vi.mock("../editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../editor")>();
  return {
    ...actual,
    hoverText: mocks.hoverText,
  };
});

import { useTypeLookup } from "./useTypeLookup";

describe("useTypeLookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    hookState.slots = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queries the updated LSP client after lsp changes and ignores late responses from the old one", async () => {
    const client1 = { name: "old" } as unknown as LSPClient;
    const client2 = { name: "new" } as unknown as LSPClient;
    const editor = { current: { view: {} } as unknown as CodeEditor };
    const fileUri = { current: "file:///day01.hs" as string | null };
    const onHover = vi.fn();

    let resolveOld!: (value: string | null) => void;
    mocks.hoverText
      .mockReturnValueOnce(
        new Promise<string | null>((res) => {
          resolveOld = res;
        }),
      )
      .mockResolvedValueOnce("Int -> Int");

    let currentLsp: { readonly client: LSPClient } | null = { client: client1 };
    const render = () => {
      hookState.cursor = 0;
      return useTypeLookup(currentLsp, editor, fileUri, onHover);
    };

    const lookup1 = render();
    lookup1(10);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.hoverText).toHaveBeenCalledTimes(1);
    expect(mocks.hoverText).toHaveBeenLastCalledWith(
      client1,
      "file:///day01.hs",
      editor.current.view,
      10,
    );

    // Switch LSP connection (as when changing On-device mode) while client1's hover is still in flight.
    currentLsp = { client: client2 };
    const lookup2 = render();
    expect(lookup2).toBe(lookup1);

    resolveOld("stale type");
    await Promise.resolve();
    expect(onHover).not.toHaveBeenCalled();

    lookup2(15);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.hoverText).toHaveBeenCalledTimes(2);
    expect(mocks.hoverText).toHaveBeenLastCalledWith(
      client2,
      "file:///day01.hs",
      editor.current.view,
      15,
    );
    await Promise.resolve();
    expect(onHover).toHaveBeenCalledWith("Int -> Int");
  });
});
