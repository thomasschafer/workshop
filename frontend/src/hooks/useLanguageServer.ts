import type { RefObject } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import {
  type CodeEditor,
  type LanguageServerBackend,
  LanguageServerConnection,
  type LanguageServerStatus,
  type LanguageServerUnavailable,
} from "../editor";
import { getHelpers } from "../offline/db";
import type { OnDeviceMode } from "../preferences";

/** A language server to connect to through the server's relay or an on-device WASM worker. */
export interface LanguageServerSetup {
  rootUri: string;
  /** Sent to the language server as it starts. */
  options: unknown;
  /** The relay's address, such as `/api/lsp`. */
  path: string;
  /** Language id (e.g. `haskell`) used to look up an installed on-device WASM bundle. */
  languageId?: string | undefined;
  /** Per-device routing preference (`server` / `automatic` / `local`). */
  mode?: OnDeviceMode | undefined;
}

/** What a connection said, and which connection said it. */
interface Said<T> {
  by: LanguageServerConnection;
  value: T;
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
  const [lspBackend, setLspBackend] = useState<LanguageServerBackend>("server");
  // Kept with the connection that said them, so a new connection starts with neither. Clearing
  // them once it's made would be too late: it may have given up by then.
  const [error, setError] = useState<Said<string> | null>(null);
  const [unavailable, setUnavailable] = useState<Said<LanguageServerUnavailable> | null>(null);
  const lsp = useMemo(() => {
    if (!setup) return null;
    setLspBackend("server");
    const connection: LanguageServerConnection = new LanguageServerConnection(
      setup.rootUri,
      setup.options,
      setLspStatus,
      (message) => setError({ by: connection, value: message }),
      (why) => setUnavailable(why && { by: connection, value: why }),
      setup.path,
      setup.languageId
        ? {
            languageId: setup.languageId,
            mode: setup.mode ?? "server",
            onBackend: setLspBackend,
          }
        : undefined,
    );
    return connection;
  }, [key]);
  useEffect(() => () => lsp?.close(), [lsp]);
  useEffect(() => {
    const langId = setup?.languageId;
    if (!lsp || !langId) return;
    let cancelled = false;
    void getHelpers(langId).then((cached) => {
      if (cancelled || !cached) return;
      const name = cached.file.split("/").pop() ?? cached.file;
      lsp.setHelpers([{ name, text: cached.text }]);
    });
    return () => {
      cancelled = true;
    };
  }, [lsp, setup?.languageId, lspBackend]);
  const lspError = error?.by === lsp ? error.value : null;
  const lspUnavailable = unavailable?.by === lsp ? unavailable.value : null;
  useEffect(() => {
    if (lspStatus === "reconnecting" || lspStatus === "unavailable") {
      editor.current?.clearDiagnostics();
      setError(null);
    }
  }, [lspStatus]);
  return {
    lsp,
    lspStatus,
    lspBackend,
    lspError,
    lspUnavailable,
    dismissLspError: () => setError(null),
    restartLsp: () => api.restartLanguageServers(),
    retryLsp: () => lsp?.retry(),
    reconnectServerLsp: () => lsp?.reconnectServer(),
  };
}
