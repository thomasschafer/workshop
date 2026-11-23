import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CodeEditor } from "../editor";
import { errorMessage } from "../errors";
import type { EditorSettings } from "../hooks/useEditorSettings";
import type { VersionedSaver } from "../saver";
import { codingApi } from "./api";
import { EditorPane, projectFile } from "./editorPane";
import { newFileProblem, search } from "./steps";
import type { OpenedProject, ProjectFile } from "./types";

/** Whether a project's file differs from how it's given: changed, added, or as it was. */
export type FileState = "changed" | "added" | null;

export function fileState(file: ProjectFile, text: string): FileState {
  if (file.original === null) return "added";
  return text === file.original ? null : "changed";
}

/** The file a project opens at: the one open last, or its first that isn't a test. */
export function openAt(project: OpenedProject, file: string | null | undefined): string {
  const files = project.files;
  if (file && files.some((f) => f.path === file)) return file;
  return (files.find((f) => !f.read_only) ?? files[0])?.path ?? "";
}

/**
 * A project's files, one at a time in the editor, with a menu to switch between them that
 * shows which the learner has changed or added and which are tests, to read but not change; a
 * search across them; and a way to add a file. Which file is open is saved with the session,
 * through `onOpen`, so it's open again on coming back.
 */
export function ProjectFiles({
  itemKey,
  project,
  open,
  onOpen,
  settings,
  editor,
  saver,
  statusHost,
}: {
  itemKey: string;
  project: OpenedProject;
  /** The file open, by its name. */
  open: string;
  onOpen: (path: string) => void;
  settings: EditorSettings;
  editor: { current: CodeEditor | null };
  saver: { current: VersionedSaver | null };
  statusHost: { current: HTMLElement | null };
}) {
  const [files, setFiles] = useState<ProjectFile[]>(project.files);
  // What each file has in it now, as it's typed, for marking what's changed and for search.
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(project.files.map((f) => [f.path, f.code.text])),
  );
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const goTo = useRef<number | null>(null);
  const current = files.find((f) => f.path === open) ?? files[0];
  // Each save is kept with the file, so coming back to it starts from what was saved last.
  const edited = useMemo(() => {
    if (!current) return null;
    const file = projectFile(itemKey, project, current);
    return {
      ...file,
      save: async (text: string, version: string, keepalive: boolean) => {
        const code = await file.save(text, version, keepalive);
        setFiles((all) => all.map((f) => (f.path === current.path ? { ...f, code } : f)));
        return code;
      },
    };
  }, [itemKey, project, current?.path]);

  // A line found by searching is gone to once its file's editor is made.
  useEffect(() => {
    if (goTo.current !== null) {
      editor.current?.gotoLine(goTo.current);
      goTo.current = null;
    }
  }, [open]);

  const switchTo = async (path: string, line: number | null = null) => {
    setMenu(false);
    setQuery("");
    if (path === open) {
      if (line !== null) editor.current?.gotoLine(line);
      return;
    }
    // Saved first, so what was typed is there to come back to.
    await saver.current?.flush().catch(() => {});
    goTo.current = line;
    onOpen(path);
  };

  const add = async () => {
    if (adding === null) return;
    const name = adding.trim();
    const why = newFileProblem(
      name,
      files.map((f) => f.path),
    );
    if (why) {
      setProblem(why);
      return;
    }
    setProblem(null);
    try {
      const code = await codingApi.saveFile(itemKey, name, "", project.empty_version);
      const sibling = files[0]?.uri ?? "";
      const added: ProjectFile = {
        path: name,
        code,
        original: null,
        read_only: false,
        uri: `${sibling.slice(0, sibling.lastIndexOf("/") + 1)}${encodeURIComponent(name)}`,
      };
      setFiles((all) => [...all, added].sort((a, b) => (a.path < b.path ? -1 : 1)));
      setTexts((all) => ({ ...all, [name]: code.text }));
      setAdding(null);
      void switchTo(name);
    } catch (e) {
      setProblem(errorMessage(e));
    }
  };

  const found = search(
    files.map((f) => ({ path: f.path, text: texts[f.path] ?? f.code.text })),
    query,
  );
  const state = (file: ProjectFile) => fileState(file, texts[file.path] ?? file.code.text);
  const changed = files.filter((f) => state(f) !== null).length;
  if (!current || !edited) return null;
  const currentState = state(current);
  return (
    <div class="project-files">
      <div class="project-bar">
        <button
          type="button"
          class="project-switch"
          aria-haspopup="true"
          aria-expanded={menu}
          aria-label={`File: ${current.path}. Switch file`}
          onClick={() => setMenu((shown) => !shown)}
        >
          <span class="project-file-name">{current.path}</span>
          {currentState ? <FileMark state={currentState} /> : null}
          {current.read_only ? <span class="project-tag">tests · read-only</span> : null}
          <span class="project-switch-arrow" aria-hidden="true">
            {menu ? "▴" : "▾"}
          </span>
        </button>
        <span class="project-count muted small">
          {files.length} files{changed > 0 ? ` · ${changed} changed` : ""}
        </span>
      </div>
      {menu ? (
        <div class="project-menu">
          <ul class="project-list" aria-label="Files">
            {files.map((file) => {
              const marked = state(file);
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    class={`project-entry ${file.path === current.path ? "current" : ""}`}
                    aria-current={file.path === current.path ? "true" : undefined}
                    onClick={() => void switchTo(file.path)}
                  >
                    <span class="project-file-name">{file.path}</span>
                    {marked ? <FileMark state={marked} /> : null}
                    {file.read_only ? <span class="project-tag">tests · read-only</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <label class="project-search">
            <span class="visually-hidden">Search the files</span>
            <input
              type="search"
              placeholder="Search the files"
              autoComplete="off"
              autoCorrect="off"
              spellcheck={false}
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          {query.trim() ? (
            found.length > 0 ? (
              <ul class="project-found" aria-label="Found">
                {found.map((hit) => (
                  <li key={`${hit.path}:${hit.line}`}>
                    <button type="button" onClick={() => void switchTo(hit.path, hit.line)}>
                      <span class="project-found-where">
                        {hit.path}:{hit.line}
                      </span>
                      <code>{hit.text}</code>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="muted small">Nothing found.</p>
            )
          ) : null}
          {adding === null ? (
            <button type="button" class="text-button" onClick={() => setAdding("")}>
              Add a file
            </button>
          ) : (
            <form
              class="project-add"
              onSubmit={(event) => {
                event.preventDefault();
                void add();
              }}
            >
              <label>
                <span class="visually-hidden">New file's name</span>
                <input
                  type="text"
                  placeholder="clock.py"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellcheck={false}
                  value={adding}
                  onInput={(event) => setAdding(event.currentTarget.value)}
                />
              </label>
              <button type="submit" class="pill">
                Add
              </button>
              <button type="button" class="text-button" onClick={() => setAdding(null)}>
                Cancel
              </button>
            </form>
          )}
          {problem ? (
            <p class="error-text small" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}
      <EditorPane
        itemKey={itemKey}
        file={edited}
        settings={settings}
        editor={editor}
        saver={saver}
        statusHost={statusHost}
        onText={(text) => setTexts((all) => ({ ...all, [current.path]: text }))}
      />
    </div>
  );
}

function FileMark({ state }: { state: "changed" | "added" }) {
  return (
    <span class={`project-mark ${state}`} title={state === "added" ? "Added" : "Changed"}>
      {state === "added" ? "new" : "changed"}
    </span>
  );
}
