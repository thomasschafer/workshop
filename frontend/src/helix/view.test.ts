import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultKeymaps } from "./keymap";
import { helixKeybindings } from "./view";

class FakeTarget {
  readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  readonly children: unknown[] = [];

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  append(...nodes: unknown[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: unknown[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  setAttribute(): void {}
  querySelector(): null {
    return null;
  }
  getBoundingClientRect() {
    return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 };
  }
  style: Record<string, string> = {};
}

class FakeElement extends FakeTarget {
  className = "";
  textContent = "";
  inputMode = "";
  value = "";
  removed = false;
  focusCalls = 0;
  blurCalls = 0;

  constructor(readonly tagName: string) {
    super();
  }

  focus(): void {
    this.focusCalls++;
  }

  blur(): void {
    this.blurCalls++;
  }

  remove(): void {
    this.removed = true;
  }

  setSelectionRange(): void {}
}

interface ViewPluginSpec {
  readonly plugin: { create(view: EditorView, arg: unknown): { destroy?(): void } };
  readonly arg: unknown;
}

function findViewPlugins(extension: Extension): ViewPluginSpec[] {
  const specs: ViewPluginSpec[] = [];
  const seen = new Set<unknown>();
  const walk = (ext: unknown): void => {
    if (!ext || typeof ext !== "object" || seen.has(ext)) return;
    seen.add(ext);
    if (Array.isArray(ext)) {
      for (const item of ext) walk(item);
      return;
    }
    if ("extension" in ext) walk((ext as { extension: unknown }).extension);
    if ("value" in ext) {
      const val = (ext as { value: unknown }).value;
      if (
        val &&
        typeof val === "object" &&
        "plugin" in val &&
        typeof (val as ViewPluginSpec).plugin?.create === "function"
      ) {
        specs.push(val as ViewPluginSpec);
      }
    }
  };
  walk(extension);
  return specs;
}

describe("HelixView touch click listener lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("removes its contentDOM click listener in destroy() so destroyed instances stop reacting", () => {
    const win = new FakeTarget();
    const doc = new FakeTarget();
    const createdTextareas: FakeElement[] = [];

    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true }),
      addEventListener: win.addEventListener.bind(win),
      removeEventListener: win.removeEventListener.bind(win),
      visualViewport: undefined,
    });
    vi.stubGlobal("document", {
      activeElement: null,
      addEventListener: doc.addEventListener.bind(doc),
      removeEventListener: doc.removeEventListener.bind(doc),
      createElement: (tag: string) => {
        const el = new FakeElement(tag);
        if (tag === "textarea") createdTextareas.push(el);
        return el;
      },
      createTextNode: (text: string) => ({ text }),
    });

    const dom = new FakeElement("div");
    const contentDOM = new FakeElement("div");
    const scrollDOM = new FakeElement("div");
    const dispatch = vi.fn();

    const ext = helixKeybindings({
      keymaps: defaultKeymaps(),
      options: {},
      language: "python",
      documentName: "a.py",
      lsp: null,
      actions: {
        write: async () => {},
        reload: async () => {},
        showProblems: () => {},
        restartLanguageServer: async () => {},
        format: async () => false,
        setLineWrapping: () => {},
        lineWrapping: () => false,
      },
    });
    const state = EditorState.create({ doc: "hello\nworld\n", extensions: [ext] });
    const view = {
      state,
      dom,
      contentDOM,
      scrollDOM,
      visibleRanges: [{ from: 0, to: 12 }],
      hasFocus: false,
      posAtCoords: () => 2,
      dispatch,
      requestMeasure: () => {},
      plugin: () => null,
    } as unknown as EditorView;

    const specs = findViewPlugins(ext);
    const instances = specs.map((spec) => spec.plugin.create(view, spec.arg));
    const textarea = createdTextareas[0];
    if (!textarea) throw new Error("expected touch HelixView to create a keyboard textarea");

    // While active, clicking contentDOM moves the selection and focuses the hidden textarea.
    contentDOM.dispatch("click", { clientX: 10, clientY: 10 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(textarea.focusCalls).toBe(1);

    // After destroy(), clicking contentDOM must not invoke the destroyed listener.
    for (const inst of instances) inst.destroy?.();
    expect(textarea.removed).toBe(true);
    dispatch.mockClear();
    textarea.focusCalls = 0;

    contentDOM.dispatch("click", { clientX: 10, clientY: 10 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(textarea.focusCalls).toBe(0);
  });
});
