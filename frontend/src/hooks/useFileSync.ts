import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";
import { api, type DayMeta, type Puzzle, type UiState } from "../api";
import type { CodeEditor } from "../editor";
import type { LatestSaver, VersionedSaver } from "../saver";

/** How often to look for changes made elsewhere while a puzzle is open. */
const CHANGES_CHECK_MS = 10_000;

interface Options {
  puzzleRef: RefObject<Puzzle | null>;
  editor: RefObject<CodeEditor | null>;
  saver: RefObject<VersionedSaver | null>;
  notesSaver: RefObject<VersionedSaver | null>;
  metaSavers: RefObject<Map<string, LatestSaver<DayMeta>>>;
  stateSaver: LatestSaver<UiState>;
  notify: (tone: "info", text: string) => void;
  /** Shows notes changed elsewhere. */
  onNotes: (text: string) => void;
}

/**
 * Saves when the phone is put down, and picks up changes made elsewhere, such as at the server
 * in an editor of one's own: when the app comes back, and every so often while it's open, as a
 * phone kept awake beside the keyboard never goes away.
 */
export function useFileSync({
  puzzleRef,
  editor,
  saver,
  notesSaver,
  metaSavers,
  stateSaver,
  notify,
  onNotes,
}: Options): void {
  useEffect(() => {
    const onHide = () => {
      saver.current?.flushOnExit();
      notesSaver.current?.flushOnExit();
      for (const metaSaver of metaSavers.current.values()) metaSaver.flushOnExit();
      stateSaver.flushOnExit();
    };
    let checking = false;
    const pickUpChanges = async () => {
      const p = puzzleRef.current;
      const current = editor.current;
      if (!p || !current || checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const opened = await api.open(p);
        if (puzzleRef.current !== p || editor.current !== current) return;
        // Each saver only takes the version from elsewhere if there are no local changes;
        // otherwise it saves them, which reports a conflict if the file changed.
        if (saver.current?.adopt(opened.code)) {
          current.replaceAll(opened.code.text);
          notify("info", "Loaded code changed elsewhere.");
        }
        if (notesSaver.current?.adopt(opened.notes)) {
          onNotes(opened.notes.text);
        }
      } catch {
        // Offline or the server restarted; the next save will report any real problem.
      } finally {
        checking = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
      else void pickUpChanges();
    };
    const onFocus = () => void pickUpChanges();
    const timer = setInterval(() => void pickUpChanges(), CHANGES_CHECK_MS);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [stateSaver]);
}
