import type { RefObject } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import {
  type CodeEditor,
  LanguageServerConnection,
  type LanguageServerStatus,
  type LanguageServerUnavailable,
} from "../editor";

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
 * server reported, until it's dismissed or the server's replaced, and `lspUnavailable` why the
 * server's been given up on, if it has, until it's tried again with `retryLsp`.
 */
export function useLanguageServer(
  setup: LanguageServerSetup | null,
  key: unknown,
  editor: RefObject<CodeEditor | null>,
) {
  const [lspStatus, setLspStatus] = useState<LanguageServerStatus>("connecting");
  const [lspError, setLspError] = useState<string | null>(null);
  const [lspUnavailable, setLspUnavailable] = useState<LanguageServerUnavailable | null>(null);
  const lsp = useMemo(
    () =>
      setup
        ? new LanguageServerConnection(
            setup.rootUri,
            setup.options,
            setLspStatus,
            setLspError,
            setLspUnavailable,
            setup.path,
          )
        : null,
    [key],
  );
  useEffect(() => {
    setLspError(null);
    setLspUnavailable(null);
    return () => lsp?.close();
  }, [lsp]);
  useEffect(() => {
    if (lspStatus === "reconnecting" || lspStatus === "unavailable") {
      editor.current?.clearDiagnostics();
      setLspError(null);
    }
  }, [lspStatus]);
  return {
    lsp,
    lspStatus,
    lspError,
    lspUnavailable,
    dismissLspError: () => setLspError(null),
    restartLsp: () => api.restartLanguageServers(),
    retryLsp: () => lsp?.retry(),
  };
}
