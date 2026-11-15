import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { CodeEditor, type Diagnostics, NO_DIAGNOSTICS } from "../editor";
import type { EditorSettings } from "../hooks/useEditorSettings";
import { useLanguageServer } from "../hooks/useLanguageServer";
import { type FileVersion, type SaveStatus, VersionedSaver } from "../saver";
import { ConflictBanner } from "../views/frame";
import { ProblemsSheet } from "../views/problems";
import { StatusLine } from "../views/status";
import { codingApi } from "./api";
import { ToolchainOffer } from "./toolchain";
import type { OpenedLanguage } from "./types";

/**
 * A problem's code in one language, in Workshop's editor: with Helix's keybindings and the
 * language server if they're on, saved to the server as it's typed and kept on the device until
 * it is, so nothing's lost to a reload or a dropped connection.
 */
export function EditorPane({
  itemKey,
  language,
  settings,
  editor,
  saver,
  statusHost,
}: {
  itemKey: string;
  language: OpenedLanguage;
  settings: EditorSettings;
  /** The editor, once it's made, for the keyboard and for reading the code. */
  editor: RefObject<CodeEditor | null>;
  /** The draft's saver, for saving before running. */
  saver: RefObject<VersionedSaver | null>;
  /** Where Helix's status line goes while Workshop's own keyboard is up. */
  statusHost: RefObject<HTMLElement | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>(NO_DIAGNOSTICS);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [conflict, setConflict] = useState<FileVersion | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const { lsp, lspStatus, lspError, lspUnavailable, dismissLspError, restartLsp, retryLsp } =
    useLanguageServer(
      language.lsp
        ? {
            rootUri: language.lsp.root_uri,
            options: language.lsp.options,
            path: `/api/coding/lsp/${language.id}`,
          }
        : null,
      language.id,
      editor,
    );

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const code = new VersionedSaver(
      (text, version, keepalive) =>
        codingApi.saveCode(itemKey, language.id, text, version, keepalive),
      `workshop:unsaved:coding:${itemKey}:${language.id}`,
      language.code.version,
      language.code.text,
      setSaveStatus,
      setConflict,
    );
    saver.current = code;
    const fileName = language.code.path.split(/[\\/]/).pop() ?? "code";
    const created = new CodeEditor(parent, {
      doc: code.recover(),
      cursor: null,
      mode: language.editor_mode,
      ...settings.editorOptions(),
      helix: settings.helixSetup(fileName, {
        write: async () => {
          await code.flush();
        },
        reload: async () => {
          await code.flush();
          const opened = await codingApi.open(itemKey);
          const fresh = opened.languages.find((l) => l.id === language.id);
          if (fresh && code.adopt(fresh.code)) created.replaceAll(fresh.code.text);
        },
        showProblems: () => setShowProblems(true),
        restartLanguageServer: restartLsp,
      }),
      lsp: lsp
        ? {
            client: lsp.client,
            uri: language.lsp?.file_uri ?? "",
            languageId: language.lsp?.language_id ?? "",
          }
        : null,
      // A problem's code is formatted only when asked, by the language server, as the server has
      // no formatter for it and runs don't wait to format it first.
      formatter: null,
      formatAutomatically: false,
      onChange: (text) => code.schedule(text),
      onCursor: () => {},
      onDiagnostics: setDiagnostics,
    });
    created.setStatusHost(statusHost.current);
    editor.current = created;
    return () => {
      code.close();
      if (saver.current === code) saver.current = null;
      created.destroy();
      if (editor.current === created) editor.current = null;
    };
  }, [itemKey, language.id, lsp]);

  const resolve = (keep: "mine" | "theirs") => {
    if (!conflict) return;
    if (keep === "mine") {
      saver.current?.keepMine(conflict);
    } else {
      saver.current?.takeTheirs(conflict);
      editor.current?.replaceAll(conflict.text);
    }
    setConflict(null);
  };

  return (
    <div class="code-pane">
      {conflict ? <ConflictBanner what="code" onResolve={resolve} /> : null}
      <StatusLine
        checks={lsp ? lspStatus : null}
        unavailable={lspUnavailable}
        onRetry={retryLsp}
        serverError={lspError !== null}
        diagnostics={diagnostics}
        saveStatus={saveStatus}
        hover={null}
        showProblem={!settings.helixOn}
        onProblems={() => setShowProblems(true)}
      />
      <ToolchainOffer key={language.id} language={language.id} onInstalled={retryLsp} />
      <div class="editor" ref={host} />
      {showProblems ? (
        <ProblemsSheet
          problems={editor.current?.problems() ?? []}
          current={diagnostics.atCursor}
          server={
            lsp ? { error: lspError, onDismiss: dismissLspError, onRestart: restartLsp } : null
          }
          onGoto={(problem) => {
            editor.current?.gotoProblem(problem);
            setShowProblems(false);
          }}
          onClose={() => setShowProblems(false)}
        />
      ) : null}
    </div>
  );
}
