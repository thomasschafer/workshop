import type { RefObject } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
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
 * new setup, told apart by `key`, starts a new connection. `lspError` is the last error the
 * server reported, until it's dismissed or the server's replaced.
 */
export function useLanguageServer(
  setup: LanguageServerSetup | null,
  key: unknown,
  editor: RefObject<CodeEditor | null>,
) {
  const [lspStatus, setLspStatus] = useState<LanguageServerStatus>("connecting");
  const [lspError, setLspError] = useState<string | null>(null);
  const lsp = useMemo(
    () =>
      setup
        ? new LanguageServerConnection(
            setup.rootUri,
            setup.options,
            setLspStatus,
            setLspError,
            setup.path,
          )
        : null,
    [key],
  );
  useEffect(() => {
    setLspError(null);
    return () => lsp?.close();
  }, [lsp]);
  useEffect(() => {
    if (lspStatus === "reconnecting") {
      editor.current?.clearDiagnostics();
      setLspError(null);
    }
  }, [lspStatus]);
  return {
    lsp,
    lspStatus,
    lspError,
    dismissLspError: () => setLspError(null),
    restartLsp: () => api.restartLanguageServers(),
  };
}
