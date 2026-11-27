import type { LSPClient } from "@codemirror/lsp-client";
import type { RefObject } from "preact";
import { useMemo, useRef } from "preact/hooks";
import { type CodeEditor, hoverText } from "../editor";
import { debounced } from "../saver";

/**
 * Debounced type-at-cursor lookup against the current language server, reading the latest
 * connection via a ref so switching On-device mode doesn't leave hover queries on a closed client.
 */
export function useTypeLookup(
  lsp: { readonly client: LSPClient } | null,
  editor: RefObject<CodeEditor | null>,
  fileUri: RefObject<string | null>,
  onHover: (text: string | null) => void,
): (pos: number) => void {
  const lspRef = useRef(lsp);
  lspRef.current = lsp;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  return useMemo(
    () =>
      debounced((pos: number) => {
        const client = lspRef.current?.client;
        const view = editor.current?.view;
        const uri = fileUri.current;
        if (!client || !view || !uri) return;
        hoverText(client, uri, view, pos)
          .then((text) => {
            if (lspRef.current?.client === client && fileUri.current === uri) {
              onHoverRef.current(text);
            }
          })
          .catch(() => {
            if (lspRef.current?.client === client && fileUri.current === uri) {
              onHoverRef.current(null);
            }
          });
      }, 500),
    [],
  );
}
