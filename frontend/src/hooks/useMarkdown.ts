import { useEffect, useState } from "preact/hooks";

export type Renderer = typeof import("../markdown").renderMarkdown;

// The renderer is loaded when first needed, so pages that never show markdown don't pay for it.
let renderer: Renderer | null = null;

/** Loads the markdown renderer, such as ahead of going offline, so it's there when needed. */
export function loadMarkdown(): Promise<Renderer> {
  return import("../markdown").then((module) => {
    renderer = module.renderMarkdown;
    return module.renderMarkdown;
  });
}

/** The markdown renderer, or null until it's loaded. */
export function useMarkdown(): Renderer | null {
  const [loaded, setLoaded] = useState(() => renderer);
  useEffect(() => {
    if (loaded !== null) return;
    loadMarkdown()
      .then((render) => setLoaded(() => render))
      // What would be formatted still shows, as plain text.
      .catch((e: unknown) => console.error("Couldn't load the markdown renderer", e));
  }, [loaded]);
  return loaded;
}
