import type { RefObject } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Bootstrap } from "../api";
import { type CodeEditor, LanguageServerConnection, type LanguageServerStatus } from "../editor";

/** The connection to the language's server, if it has one, shared by every puzzle's editor. */
export function useLanguageServer(boot: Bootstrap, editor: RefObject<CodeEditor | null>) {
  const [lspStatus, setLspStatus] = useState<LanguageServerStatus>("connecting");
  const lsp = useMemo(
    () =>
      boot.language.has_lsp
        ? new LanguageServerConnection(
            boot.language.root_uri,
            boot.language.lsp_options,
            setLspStatus,
          )
        : null,
    [boot],
  );
  useEffect(() => () => lsp?.close(), [lsp]);
  useEffect(() => {
    if (lspStatus === "reconnecting") editor.current?.clearDiagnostics();
  }, [lspStatus]);
  return { lsp, lspStatus };
}
