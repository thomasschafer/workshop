import type { RefObject } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type CodeEditor, LanguageServerConnection, type LanguageServerStatus } from "../editor";

/** A language server to connect to through the server's relay. */
export interface LanguageServerSetup {
  rootUri: string;
  /** Sent to the language server as it starts. */
  options: unknown;
  /** The relay's address, such as `/api/lsp`. */
  path: string;
}

/**
 * The connection to a language server, if there's one, shared by every editor of its files. A
 * new setup, told apart by `key`, starts a new connection.
 */
export function useLanguageServer(
  setup: LanguageServerSetup | null,
  key: unknown,
  editor: RefObject<CodeEditor | null>,
) {
  const [lspStatus, setLspStatus] = useState<LanguageServerStatus>("connecting");
  const lsp = useMemo(
    () =>
      setup
        ? new LanguageServerConnection(setup.rootUri, setup.options, setLspStatus, setup.path)
        : null,
    [key],
  );
  useEffect(() => () => lsp?.close(), [lsp]);
  useEffect(() => {
    if (lspStatus === "reconnecting") editor.current?.clearDiagnostics();
  }, [lspStatus]);
  return { lsp, lspStatus };
}
