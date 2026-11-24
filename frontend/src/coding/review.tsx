import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ApiError, type Bootstrap } from "../api";
import { errorMessage } from "../errors";
import { MarkedView } from "../grading/marked";
import { useConnection } from "../hooks/useConnection";
import { newId } from "../learning/local";
import { Markdown } from "../learning/practice";
import { HomeButton } from "../progress/page";
import { LatestSaver } from "../saver";
import type { TrackId } from "../tracks/types";
import { DictateButton } from "../views/dictate";
import { codingApi } from "./api";
import { CodingLink, comesBack, more } from "./problem";
import { commentIsOn, commentPlace, fold, type Shown } from "./steps";
import type {
  Comment,
  DiffLine,
  FileChange,
  OpenedReview,
  ReviewFile,
  ReviewMarked,
  ReviewSession,
} from "./types";

/** How long typing a comment pauses before the review's saved. */
const SAVE_DELAY_MS = 600;

/** How many lines kept the same are shown around each change. */
const CONTEXT = 3;

/** A line to bring into view, unfolding it if it's folded away, as asked for at `at`. */
interface Focus {
  file: string;
  line: number | null;
  old: boolean;
  at: number;
}

/** Where a comment's being written: on a line, or on the change as a whole. */
type Writing = { file: string; line: number; old: boolean; id: string | null } | null;

/**
 * Reviewing a change to a project: reading its diff, a file at a time, and writing comments,
 * typed or dictated, each on a line, tapped, or on the change as a whole. Comments, and the file
 * open, are saved as they're written. Once submitted, the grader marks them against the defects
 * planted in the change, which finishes the review.
 */
export function ReviewView({
  boot,
  opened,
  onHome,
  onTrack,
}: {
  boot: Bootstrap;
  opened: OpenedReview;
  onHome: () => void;
  onTrack: (track: TrackId) => void;
}) {
  const online = useConnection();
  const [session, setSession] = useState<ReviewSession>(opened.session);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ReviewSession | null>(null);
  const [writing, setWriting] = useState<Writing>(null);
  const [whole, setWhole] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [marked, setMarked] = useState<ReviewMarked | null>(null);
  // One attempt however many times it's sent, so a reply lost on the way is given again.
  const attempt = useRef(newId());
  // What's typed in a comment box not yet added, which submitting adds rather than loses.
  const drafts = useRef({ line: "", overall: "" });
  const [focus, setFocus] = useState<Focus | null>(null);
  // Open to start with, before there are comments, and then as the learner leaves it.
  const [promptOpen] = useState(() => opened.session.comments.length === 0);
  const onList = () => onTrack(opened.track.id);

  // The versions this page's comments have been based on since it last took the review as it
  // was changed elsewhere: its own saves', and those it chose to keep its comments over.
  const ownVersions = useRef(new Set([opened.session.version]));
  const saver = useMemo(
    () =>
      new LatestSaver<ReviewSession>(
        async (next, keepalive) => {
          // A change made while an earlier save was on its way is based on the version before
          // that save, but follows on from it, so it's sent as based on the version it gave.
          const base = ownVersions.current.has(next.version)
            ? { ...next, version: sessionRef.current.version }
            : next;
          try {
            const saved = await codingApi.saveReview(opened.key, base, keepalive);
            ownVersions.current.add(saved.version);
            // Only the version is the server's: what's typed since stays as it is.
            const bumped = { ...sessionRef.current, version: saved.version };
            sessionRef.current = bumped;
            setSession(bumped);
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
              const current = (e.body as { current?: ReviewSession } | null)?.current;
              if (current) {
                setConflict(current);
                return;
              }
            }
            throw e;
          }
        },
        SAVE_DELAY_MS,
        setNotice,
      ),
    [opened.key],
  );
  useEffect(() => {
    const leave = () => saver.flushOnExit();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [saver]);

  const change = (update: (session: ReviewSession) => ReviewSession) => {
    const next = update(sessionRef.current);
    sessionRef.current = next;
    setSession(next);
    saver.schedule(next);
  };

  const files = opened.files;
  const current = files.find((f) => f.path === session.file) ?? files[0];
  const comments = session.comments;
  const saveComment = (text: string) => {
    if (!writing) return;
    const trimmed = text.trim();
    change((s) => {
      const others = s.comments.filter((c) => c.id !== writing.id);
      if (!trimmed) return { ...s, comments: others };
      const comment: Comment = {
        id: writing.id ?? newId(),
        file: writing.file,
        line: writing.line,
        old: writing.old,
        text: trimmed,
      };
      return writing.id
        ? { ...s, comments: s.comments.map((c) => (c.id === writing.id ? comment : c)) }
        : { ...s, comments: [...others, comment] };
    });
    drafts.current.line = "";
    setWriting(null);
  };

  const addOverall = (text: string) => {
    drafts.current.overall = "";
    change((s) => ({
      ...s,
      comments: [...s.comments, { id: newId(), file: null, line: null, old: false, text }],
    }));
  };

  const submit = async () => {
    setSubmitting(true);
    setProblem(null);
    try {
      if (writing && drafts.current.line.trim()) saveComment(drafts.current.line);
      if (drafts.current.overall.trim()) addOverall(drafts.current.overall.trim());
      await saver.flush();
      const result = await codingApi.submitReview(opened.key, attempt.current);
      setMarked(result);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const header = (
    <header class="top">
      <span class="header-start">
        <HomeButton onHome={onHome} />
        <CodingLink track={opened.track} onList={onList} />
      </span>
      {online ? null : (
        <span class="learn-sync offline" role="status">
          Offline
        </span>
      )}
    </header>
  );

  if (marked) {
    return (
      <div class="learn">
        {header}
        <ReviewResult
          opened={opened}
          result={marked}
          onHome={onHome}
          onList={onList}
          moreLabel={more(opened.track)}
        />
      </div>
    );
  }

  return (
    <div class="learn coding-review">
      {header}
      <main class="learn-content">
        <h1 class="coding-review-title">{opened.label}</h1>
        <details class="coding-statement" open={promptOpen}>
          <summary>The change</summary>
          <Markdown text={opened.prompt} class="learn-prompt" />
          {opened.source ? <p class="learn-source muted">Source: {opened.source}</p> : null}
        </details>
        {notice ? (
          <div class="banner" role="status">
            <span>{notice}</span>
            <button type="button" class="text-button" onClick={() => setNotice(null)}>
              OK
            </button>
          </div>
        ) : null}
        {conflict ? (
          <div class="banner" role="alert">
            <span>This review was changed on another device.</span>
            <button
              type="button"
              class="text-button"
              onClick={() => {
                const mine = { ...sessionRef.current, version: conflict.version };
                ownVersions.current.add(conflict.version);
                setConflict(null);
                sessionRef.current = mine;
                setSession(mine);
                saver.schedule(mine);
              }}
            >
              Keep mine
            </button>
            <button
              type="button"
              class="text-button"
              onClick={() => {
                // A change made before this, still to be sent, is based on what's discarded.
                ownVersions.current = new Set([conflict.version]);
                setConflict(null);
                sessionRef.current = conflict;
                setSession(conflict);
              }}
            >
              Load theirs
            </button>
          </div>
        ) : null}
        {current ? (
          <>
            <FileSwitcher
              files={files}
              current={current}
              comments={comments}
              onOpen={(path) => {
                setWriting(null);
                change((s) => ({ ...s, file: path }));
              }}
            />
            {current.changed ? (
              <label class="coding-review-whole">
                <input
                  type="checkbox"
                  checked={whole}
                  onChange={(event) => setWhole(event.currentTarget.checked)}
                />
                Show the whole file
              </label>
            ) : null}
            <p class="muted small">Tap a line to comment on it.</p>
            <DiffView
              key={current.path}
              path={current.path}
              focus={focus}
              onDraft={(text) => {
                drafts.current.line = text;
              }}
              lines={current.lines}
              shown={current.changed && !whole ? fold(current.lines, CONTEXT) : null}
              comments={comments}
              writing={writing}
              serverDictation={boot.server_dictation}
              onNotice={setNotice}
              onTap={(line) =>
                setWriting({
                  file: current.path,
                  line: (line.kind === "removed" ? line.old : line.new) ?? 1,
                  old: line.kind === "removed",
                  id: null,
                })
              }
              onEdit={(comment) =>
                setWriting({
                  file: comment.file ?? current.path,
                  line: comment.line ?? 1,
                  old: comment.old,
                  id: comment.id,
                })
              }
              onSave={saveComment}
              onCancel={() => {
                drafts.current.line = "";
                setWriting(null);
              }}
            />
          </>
        ) : null}
        <OverallComment
          serverDictation={boot.server_dictation}
          onNotice={setNotice}
          onDraft={(text) => {
            drafts.current.overall = text;
          }}
          onAdd={addOverall}
        />
        <section class="coding-review-comments" aria-label="Your comments">
          <h2 class="coding-subheading">
            {comments.length === 0
              ? "No comments yet"
              : `Your ${comments.length === 1 ? "comment" : `${comments.length} comments`}`}
          </h2>
          <ul class="coding-comment-list">
            {comments.map((comment) => (
              <li key={comment.id} class="coding-comment">
                <span class="coding-comment-place muted small">{commentPlace(comment)}</span>
                <span class="coding-comment-text">{comment.text}</span>
                <span class="coding-comment-actions">
                  {comment.file !== null ? (
                    <button
                      type="button"
                      class="text-button"
                      onClick={() => {
                        if (comment.file !== current?.path) {
                          setWriting(null);
                          change((s) => ({ ...s, file: comment.file }));
                        }
                        setFocus({
                          file: comment.file ?? "",
                          line: comment.line,
                          old: comment.old,
                          at: Date.now(),
                        });
                      }}
                    >
                      Show
                    </button>
                  ) : null}
                  <button
                    type="button"
                    class="text-button"
                    onClick={() =>
                      change((s) => ({
                        ...s,
                        comments: s.comments.filter((c) => c.id !== comment.id),
                      }))
                    }
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <span class="learn-actions">
          <button
            type="button"
            class="pill primary wide"
            disabled={!online || submitting || comments.length === 0}
            onClick={() => void submit()}
          >
            {submitting ? "Marking…" : online ? "Have it marked" : "Marking needs the server"}
          </button>
        </span>
        {problem ? (
          <p class="error-text" role="alert">
            {problem}
          </p>
        ) : null}
      </main>
    </div>
  );
}

/** The file being read, and a menu of the rest, with what's changed and commented on marked. */
function FileSwitcher({
  files,
  current,
  comments,
  onOpen,
}: {
  files: ReviewFile[];
  current: ReviewFile;
  comments: Comment[];
  onOpen: (path: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const count = (path: string) => comments.filter((c) => c.file === path).length;
  const mark = (file: ReviewFile) => (
    <>
      {file.changed ? <span class="project-mark changed">changed</span> : null}
      {count(file.path) > 0 ? (
        <span class="project-tag">
          {count(file.path)} {count(file.path) === 1 ? "comment" : "comments"}
        </span>
      ) : null}
    </>
  );
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
          {mark(current)}
          <span class="project-switch-arrow" aria-hidden="true">
            {menu ? "▴" : "▾"}
          </span>
        </button>
      </div>
      {menu ? (
        <div class="project-menu">
          <ul class="project-list" aria-label="Files">
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  class={`project-entry ${file.path === current.path ? "current" : ""}`}
                  aria-current={file.path === current.path ? "true" : undefined}
                  onClick={() => {
                    setMenu(false);
                    onOpen(file.path);
                  }}
                >
                  <span class="project-file-name">{file.path}</span>
                  {mark(file)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A file's lines, with what a change adds and removes marked, wrapping rather than scrolling
 * sideways, so it reads on a phone. Long stretches kept the same are folded away unless
 * `shown` is null, and each fold opens when it's tapped. With `onTap`, tapping a line starts a
 * comment on it, and the comments on each line are shown beneath it.
 */
export function DiffView({
  path,
  lines,
  shown,
  focus = null,
  onDraft,
  comments = [],
  writing = null,
  serverDictation = false,
  onNotice = () => {},
  onTap,
  onEdit,
  onSave,
  onCancel,
}: {
  path: string;
  lines: DiffLine[];
  shown: Shown[] | null;
  /** A line to bring into view. */
  focus?: Focus | null;
  /** Told what's typed in a comment not yet added. */
  onDraft?: (text: string) => void;
  comments?: Comment[];
  writing?: Writing;
  serverDictation?: boolean;
  onNotice?: (text: string) => void;
  onTap?: (line: DiffLine) => void;
  onEdit?: (comment: Comment) => void;
  onSave?: (text: string) => void;
  onCancel?: () => void;
}) {
  const [opened, setOpened] = useState<number[]>([]);
  const list = useRef<HTMLOListElement>(null);
  const rows: Shown[] = shown ?? lines.map((line) => ({ line }));
  const rowId = (line: DiffLine) =>
    line.kind === "removed" ? `old-${line.old}` : `new-${line.new}`;
  // Brought into view, unfolded first if it's folded away.
  useEffect(() => {
    if (!focus || focus.file !== path) return;
    const at = lines.findIndex((line) =>
      focus.line === null
        ? line.kind !== "kept"
        : focus.old
          ? line.kind === "removed" && line.old === focus.line
          : line.kind !== "removed" && line.new === focus.line,
    );
    const target = lines[at];
    if (!target) return;
    const fold = rows.find(
      (row) => "folded" in row && at >= row.from && at < row.from + row.folded,
    );
    if (fold && "folded" in fold) setOpened((all) => [...all, fold.from]);
    requestAnimationFrame(() =>
      list.current
        ?.querySelector(`[data-line="${rowId(target)}"]`)
        ?.scrollIntoView({ block: "center" }),
    );
  }, [focus?.at]);
  const isWriting = (line: DiffLine) =>
    writing !== null &&
    writing.file === path &&
    (writing.old
      ? line.kind === "removed" && line.old === writing.line
      : line.kind !== "removed" && line.new === writing.line);
  return (
    <ol class="diff" ref={list} aria-label={`${path}, line by line`}>
      {rows.flatMap((row) => {
        if ("folded" in row) {
          if (opened.includes(row.from)) {
            return lines.slice(row.from, row.from + row.folded).map((line) => lineRow(line));
          }
          return [
            <li key={`fold-${row.from}`} class="diff-fold">
              <button type="button" onClick={() => setOpened((all) => [...all, row.from])}>
                {row.folded} unchanged {row.folded === 1 ? "line" : "lines"}
              </button>
            </li>,
          ];
        }
        return [lineRow(row.line)];
      })}
    </ol>
  );

  function lineRow(line: DiffLine) {
    const number = line.kind === "removed" ? line.old : line.new;
    const on = comments.filter((c) => commentIsOn(c, path, line));
    const editing = isWriting(line);
    const what = line.kind === "added" ? "added" : line.kind === "removed" ? "removed" : "";
    const content = (
      <>
        <span class="diff-number" aria-hidden="true">
          {number}
        </span>
        <span class="diff-mark" aria-hidden="true">
          {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
        </span>
        <code class="diff-text">{line.text || " "}</code>
      </>
    );
    return (
      <li
        key={`${line.kind}-${line.old}-${line.new}`}
        class={`diff-line ${line.kind}`}
        data-line={rowId(line)}
      >
        {onTap ? (
          <button
            type="button"
            class="diff-row"
            aria-label={`Line ${number}${what ? `, ${what}` : ""}: ${line.text.trim() || "blank"}. Comment on it`}
            onClick={() => onTap(line)}
          >
            {content}
          </button>
        ) : (
          <span class="diff-row">{content}</span>
        )}
        {on
          .filter((c) => !(editing && writing?.id === c.id))
          .map((comment) => (
            <div key={comment.id} class="diff-comment">
              <span>{comment.text}</span>
              {onEdit ? (
                <button type="button" class="text-button" onClick={() => onEdit(comment)}>
                  Edit
                </button>
              ) : null}
            </div>
          ))}
        {editing && onSave && onCancel ? (
          <CommentBox
            key={writing?.id ?? `new-${rowId(line)}`}
            label={`Comment on line ${number}`}
            onDraft={onDraft}
            initial={comments.find((c) => c.id === writing?.id)?.text ?? ""}
            serverDictation={serverDictation}
            onNotice={onNotice}
            onSave={onSave}
            onCancel={onCancel}
          />
        ) : null}
      </li>
    );
  }
}

/** Writing a comment, typed or dictated. */
function CommentBox({
  label,
  initial,
  serverDictation,
  onNotice,
  onSave,
  onCancel,
  onDraft,
}: {
  label: string;
  initial: string;
  /** Told what's typed, until it's added. */
  onDraft?: ((text: string) => void) | undefined;
  serverDictation: boolean;
  onNotice: (text: string) => void;
  onSave: (text: string) => void;
  onCancel?: () => void;
}) {
  const [text, setTextOnly] = useState(initial);
  const setText = (update: string | ((typed: string) => string)) =>
    setTextOnly((typed) => {
      const next = typeof update === "function" ? update(typed) : update;
      onDraft?.(next);
      return next;
    });
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const id = `comment-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <form
      class="diff-comment-box"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(text);
        setText("");
      }}
    >
      <label class="visually-hidden" for={id}>
        {label}
      </label>
      <textarea
        id={id}
        ref={field}
        rows={3}
        value={text}
        placeholder="What's wrong here?"
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <span class="learn-actions">
        <DictateButton
          serverDictation={serverDictation}
          onHeard={(heard) =>
            setText((typed) => (typed.trim() ? `${typed.trimEnd()} ${heard}` : heard))
          }
          onNotice={onNotice}
        />
        {onCancel ? (
          <button type="button" class="text-button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="submit" class="pill primary" disabled={!text.trim() && !initial}>
          {initial ? "Save" : "Add"}
        </button>
      </span>
    </form>
  );
}

/** A comment on the change as a whole, rather than a line of it. */
function OverallComment({
  serverDictation,
  onNotice,
  onDraft,
  onAdd,
}: {
  serverDictation: boolean;
  onNotice: (text: string) => void;
  onDraft: (text: string) => void;
  onAdd: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" class="learn-link" onClick={() => setOpen(true)}>
        Comment on the whole change
      </button>
    );
  }
  return (
    <section aria-label="A comment on the whole change">
      <h2 class="coding-subheading">On the whole change</h2>
      <CommentBox
        label="Comment on the whole change"
        initial=""
        serverDictation={serverDictation}
        onNotice={onNotice}
        onDraft={onDraft}
        onSave={(text) => {
          if (text.trim()) onAdd(text.trim());
          setOpen(false);
        }}
        onCancel={() => {
          onDraft("");
          setOpen(false);
        }}
      />
    </section>
  );
}

/** How the review was marked: the score, each defect found or missed, and what was planted. */
function ReviewResult({
  opened,
  result,
  onHome,
  onList,
  moreLabel,
}: {
  opened: OpenedReview;
  result: ReviewMarked;
  onHome: () => void;
  onList: () => void;
  moreLabel: string;
}) {
  return (
    <main class="learn-content">
      <h1 class="coding-review-title">{opened.label}</h1>
      <MarkedView marked={result.marked} />
      <section aria-label="What was wrong with it">
        <h2 class="coding-subheading">What was wrong with it</h2>
        <ul class="coding-defects">
          {result.defects.map((defect, at) => {
            const point = result.marked.points[at];
            const [start, end] = defect.lines;
            return (
              <li key={`${defect.file}:${start}`} class={`coding-defect ${point?.met ?? "no"}`}>
                <span class="coding-comment-place small">
                  {defect.file}, {start === end ? `line ${start}` : `lines ${start}–${end}`}
                  {point
                    ? ` · ${point.met === "yes" ? "found" : point.met === "partly" ? "partly found" : "missed"}`
                    : ""}
                </span>
                <span>{defect.description}</span>
              </li>
            );
          })}
        </ul>
        {result.notes ? <Markdown text={result.notes} class="muted" /> : null}
      </section>
      <section class="learn-done" aria-label="Done">
        <p class="muted">{comesBack(result, opened.track)}</p>
        <span class="learn-actions">
          <button type="button" class="pill" onClick={onHome}>
            Home
          </button>
          <button type="button" class="pill primary" onClick={onList}>
            {moreLabel}
          </button>
        </span>
      </section>
    </main>
  );
}

/** A project's changes, a file at a time, as the review of a fix or a refactor shows them. */
export function ChangesView({ changes, label }: { changes: FileChange[]; label: string }) {
  if (changes.length === 0) {
    return <p class="muted">No changes.</p>;
  }
  return (
    <section class="coding-changes" aria-label={label}>
      {changes.map((change) => (
        <section key={change.path} aria-label={change.path}>
          <p class="coding-change-file">
            {change.path}
            <span class="muted small">
              {" "}
              +{change.added} −{change.removed}
            </span>
          </p>
          <DiffView path={change.path} lines={change.lines} shown={fold(change.lines, CONTEXT)} />
        </section>
      ))}
    </section>
  );
}
