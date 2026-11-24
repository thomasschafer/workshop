import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { VersionedFile } from "../api";
import { CodeEditor, type Diagnostics, NO_DIAGNOSTICS } from "../editor";
import { useConnection } from "../hooks/useConnection";
import type { EditorSettings } from "../hooks/useEditorSettings";
import { useLanguageServer } from "../hooks/useLanguageServer";
import * as preferences from "../preferences";
import { type FileVersion, type SaveStatus, VersionedSaver } from "../saver";
import { ConflictBanner } from "../views/frame";
import { ProblemsSheet } from "../views/problems";
import { StatusLine } from "../views/status";
import { codingApi } from "./api";
import { updateCachedCodingDraft } from "./offline";
import { ToolchainOffer } from "./toolchain";
import type { Language, OpenedLanguage, OpenedProject, ProjectFile } from "./types";

/** A file being edited: a problem's code in one language, or a file of a project. */
export interface EditedFile {
  /** Tells files apart, for what's kept on the device until it's saved. */
  id: string;
  /** The file's name, for messages such as Helix's `:w`. */
  name: string;
  code: VersionedFile;
  /** Syntax highlighting, from the language's profile. */
  mode: string;
  /** The language its programs are in, for offering to install them. */
  language: Language;
  /** The language server for the file, shared by the files under the same root. */
  lsp: {
    rootUri: string;
    fileUri: string;
    languageId: string;
    options: unknown;
  } | null;
  /** For a file to read but not change, such as a project's tests. */
  readOnly: boolean;
  save: (text: string, version: string, keepalive: boolean) => Promise<VersionedFile>;
  /** The file as the server has it now, for Helix's `:reload`. */
  fresh: () => Promise<VersionedFile | undefined>;
}

/** A problem's code in one language, as an edited file. */
export function languageFile(itemKey: string, language: OpenedLanguage): EditedFile {
  return {
    id: language.id,
    name: language.code.path.split(/[\\/]/).pop() ?? "code",
    code: language.code,
    mode: language.editor_mode,
    language: language.id,
    lsp: language.lsp && {
      rootUri: language.lsp.root_uri,
      fileUri: language.lsp.file_uri,
      languageId: language.lsp.language_id,
      options: language.lsp.options,
    },
    readOnly: false,
    save: async (text, version, keepalive) => {
      const saved = await codingApi.saveCode(itemKey, language.id, text, version, keepalive);
      void updateCachedCodingDraft(itemKey, language.id, saved);
      return saved;
    },
    fresh: async () => {
      const opened = await codingApi.open(itemKey);
      return opened.languages.find((l) => l.id === language.id)?.code;
    },
  };
}

/** A file of a project, as an edited file. */
export function projectFile(
  itemKey: string,
  project: OpenedProject,
  file: ProjectFile,
): EditedFile {
  return {
    id: `file:${file.path}`,
    name: file.path,
    code: file.code,
    mode: project.editor_mode,
    language: "python",
    lsp: project.lsp && {
      rootUri: project.lsp.root_uri,
      fileUri: file.uri,
      languageId: project.lsp.language_id,
      options: project.lsp.options,
    },
    readOnly: file.read_only,
    save: (text, version, keepalive) =>
      codingApi.saveFile(itemKey, file.path, text, version, keepalive),
    fresh: async () => {
      const opened = await codingApi.open(itemKey);
      return opened.project?.files.find((f) => f.path === file.path)?.code;
    },
  };
}

/**
 * A file in Workshop's editor, a problem's code or a file of a project: with Helix's
 * keybindings and the language server if they're on, saved to the server as it's typed and
 * kept on the device until it is, so nothing's lost to a reload or a dropped connection. A new
 * file in the same pane keeps the language server, so moving between a project's files is
 * quick.
 */
export function EditorPane({
  itemKey,
  file,
  settings,
  editor,
  saver,
  statusHost,
  onText,
}: {
  itemKey: string;
  file: EditedFile;
  settings: EditorSettings;
  /** The editor, once it's made, for the keyboard and for reading the code. */
  editor: RefObject<CodeEditor | null>;
  /** The file's saver, for saving before running. */
  saver: RefObject<VersionedSaver | null>;
  /** Where Helix's status line goes while Workshop's own keyboard is up. */
  statusHost: RefObject<HTMLElement | null>;
  /** Told the text as it changes, such as to mark a project's file as changed. */
  onText?: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>(NO_DIAGNOSTICS);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [conflict, setConflict] = useState<FileVersion | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const online = useConnection();
  const mode = preferences.onDeviceMode.get();
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const {
    lsp,
    lspStatus,
    lspBackend,
    lspError,
    lspUnavailable,
    dismissLspError,
    restartLsp,
    retryLsp,
    reconnectServerLsp,
  } = useLanguageServer(
    file.lsp
      ? {
          rootUri: file.lsp.rootUri,
          options: file.lsp.options,
          path: `/api/coding/lsp/${file.language}`,
          languageId: file.language,
          mode,
        }
      : null,
    `${file.language}:${file.lsp?.rootUri ?? ""}:${mode}`,
    editor,
  );

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    // What was said of another file isn't this one's.
    setConflict(null);
    setSaveStatus("saved");
    setDiagnostics(NO_DIAGNOSTICS);
    setShowProblems(false);
    const code = new VersionedSaver(
      file.save,
      `workshop:unsaved:coding:${itemKey}:${file.id}`,
      file.code.version,
      file.code.text,
      setSaveStatus,
      setConflict,
    );
    saver.current = code;
    const created = new CodeEditor(parent, {
      doc: code.recover(),
      cursor: null,
      mode: file.mode,
      ...settings.editorOptions(),
      helix: settings.helixSetup(file.name, {
        write: async () => {
          await code.flush();
        },
        reload: async () => {
          await code.flush();
          const mark = code.readMark();
          const fresh = await file.fresh();
          if (fresh && code.adopt(fresh, mark)) created.replaceAll(fresh.text);
        },
        showProblems: () => setShowProblems(true),
        restartLanguageServer: restartLsp,
      }),
      lsp:
        lsp && file.lsp
          ? { client: lsp.client, uri: file.lsp.fileUri, languageId: file.lsp.languageId }
          : null,
      // A problem's code is formatted only when asked, by the language server, as the server has
      // no formatter for it and runs don't wait to format it first.
      formatter: null,
      formatAutomatically: false,
      readOnly: file.readOnly,
      onChange: (text) => {
        if (!file.readOnly) code.schedule(text);
        onTextRef.current?.(text);
      },
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
  }, [itemKey, file.id, lsp]);

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
        backend={lsp ? lspBackend : undefined}
        online={online}
        unavailable={lspUnavailable}
        onRetry={retryLsp}
        serverError={lspError !== null}
        diagnostics={diagnostics}
        saveStatus={file.readOnly ? "saved" : saveStatus}
        hover={null}
        showProblem={!settings.helixOn}
        onProblems={() => setShowProblems(true)}
      />
      <ToolchainOffer key={file.language} language={file.language} onInstalled={retryLsp} />
      <div class="editor" ref={host} />
      {showProblems ? (
        <ProblemsSheet
          problems={editor.current?.problems() ?? []}
          current={diagnostics.atCursor}
          server={
            lsp ? { error: lspError, onDismiss: dismissLspError, onRestart: restartLsp } : null
          }
          backend={lsp ? lspBackend : undefined}
          onReconnectServer={lsp && lspBackend === "local" ? reconnectServerLsp : undefined}
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
