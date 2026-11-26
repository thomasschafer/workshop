import { useEffect, useState } from "preact/hooks";

type MarkdownModule = typeof import("../markdown");
export type Renderer = MarkdownModule["renderMarkdown"];

// The renderer is loaded when first needed, so pages that never show markdown don't pay for it.
let loadedModule: MarkdownModule | null = null;

/** Loads the markdown renderer, such as ahead of going offline, so it's there when needed. */
export function loadMarkdown(): Promise<Renderer> {
  return import("../markdown").then((module) => {
    loadedModule = module;
    return module.renderMarkdown;
  });
}

/**
 * The markdown renderer, or null until it's loaded. Returns a fresh function reference whenever a
 * tree-sitter grammar finishes loading or the syntax theme changes, so callers re-render with
 * highlighted code blocks without layout jumps.
 */
export function useMarkdown(): Renderer | null {
  const [mod, setMod] = useState<MarkdownModule | null>(() => loadedModule);
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (mod !== null) {
      return mod.onMarkdownHighlightUpdate(() => setVersion((v) => v + 1));
    }
    let cancelled = false;
    import("../markdown")
      .then((module) => {
        loadedModule = module;
        if (!cancelled) setMod(module);
      })
      // What would be formatted still shows, as plain text.
      .catch((e: unknown) => console.error("Couldn't load the markdown renderer", e));
    return () => {
      cancelled = true;
    };
  }, [mod]);

  if (mod === null) return null;
  const render = mod.renderMarkdown;
  return (text: string) => render(text);
}
