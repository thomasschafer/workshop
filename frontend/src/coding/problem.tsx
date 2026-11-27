import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type Bootstrap,
  ConnectionError,
  connection,
  isTransientNetworkError,
  TimeoutError,
  type VersionedFile,
} from "../api";
import type { CodeEditor } from "../editor";
import { errorMessage } from "../errors";
import { gradingApi } from "../grading/api";
import { ExplainAloud } from "../grading/explain";
import { MarkedView } from "../grading/marked";
import type { Marked } from "../grading/types";
import { type CodeKeyboardState, useCodeKeyboard } from "../hooks/useCodeKeyboard";
import { useConnection } from "../hooks/useConnection";
import { useConversation } from "../hooks/useConversation";
import { type EditorSettings, useEditorSettings } from "../hooks/useEditorSettings";
import { newId } from "../learning/local";
import { sameOutput } from "../learning/output";
import { Markdown } from "../learning/practice";
import type { Rating } from "../learning/types";
import { outbox } from "../offline/outbox";
import {
  isLanguageCachedSync,
  refreshCachedBundles,
  subscribeCachedBundles,
} from "../onDevice/bundles";
import {
  buildCodingExampleCases,
  buildCodingSubmitCases,
  localRunner,
  resolveRunBackend,
} from "../onDevice/runner";
import * as preferences from "../preferences";
import { HomeButton } from "../progress/page";
import { LatestSaver, type VersionedSaver } from "../saver";
import { TrackIcon } from "../tracks/icons";
import type { TrackId } from "../tracks/types";
import { DictateButton } from "../views/dictate";
import { CodeKeyboard, KeyboardToggle } from "../views/keyboard";
import { StepNav } from "../views/steps";
import { useZen, ZenButton, ZenExit, ZenKeyboardButton } from "../views/zen";
import { codingApi } from "./api";
import { EditorPane, languageFile } from "./editorPane";
import {
  getCachedCodingProblem,
  getCachedCodingTests,
  openCodingFromCache,
  updateCachedCodingDraft,
  updateCachedCodingSession,
} from "./offline";
import { CodingSessionVersions } from "./offlineVersion";
import { ProjectFiles } from "./project";
import { ChangesView, ReviewView } from "./review";
import {
  applying,
  describeCase,
  describeRun,
  lastCall,
  partOf,
  printedTooMuch,
  pythonValue,
  reached,
  revealed,
  STEP_LABELS,
  sameReturn,
  sameSitting,
  showCalls,
  stepAfter,
  stepsFor,
  suggestedRating,
  TWIST_KINDS,
  testLabel,
  testOf,
} from "./steps";
import { TutorSheet } from "./tutor";
import type {
  Api,
  Case,
  CaseResult,
  Finished as FinishedReply,
  Graded,
  Language,
  Opened,
  OpenedProject,
  OpenedReview,
  OpenedTrack,
  Session,
  StepName,
  Submitted,
  TwistMarked,
} from "./types";

/** How long typing in the plan pauses before it's saved. */
const SAVE_DELAY_MS = 600;

/** A session saved on this device that the server hasn't confirmed yet, such as while offline. */
interface Unsaved {
  session: Session;
  at: number;
}

const unsavedKey = (key: string) => `workshop:unsaved:coding-session:${key}`;

function readUnsaved(key: string): Unsaved | null {
  try {
    const raw = localStorage.getItem(unsavedKey(key));
    return raw ? (JSON.parse(raw) as Unsaved) : null;
  } catch {
    return null;
  }
}

function writeUnsaved(key: string, unsaved: Unsaved | null): void {
  try {
    if (unsaved === null) localStorage.removeItem(unsavedKey(key));
    else localStorage.setItem(unsavedKey(key), JSON.stringify(unsaved));
  } catch {
    // Storage can be full or disabled; the server save is still attempted.
  }
}

/**
 * A coding problem, in steps of a few minutes: understand it, plan, code, test and review, or
 * for one solved before, answer a twist on it, or with no twist to be had, recall the plan and
 * review it. Each step is saved as it goes, so the learner can stop at any moment, and opening
 * it again carries on where they were.
 */
export function ProblemView({
  boot,
  itemKey,
  onHome,
  onTrack,
}: {
  boot: Bootstrap;
  itemKey: string;
  onHome: () => void;
  /** Goes back to a track: the Coding track's list, or the track the problem is in. */
  onTrack: (track: TrackId) => void;
}) {
  const online = useConnection();
  const [opened, setOpened] = useState<Opened | null>(null);
  // Until it's open, the way back is to the Coding track, where most problems are.
  const track = opened?.track ?? CODING_TRACK;
  const onList = () => onTrack(track.id);
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const openedRef = useRef(opened);
  openedRef.current = opened;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [finished, setFinished] = useState<FinishedReply | null>(null);
  const [twistMarked, setTwistMarked] = useState<TwistMarked | null>(null);
  const [sessionConflict, setSessionConflict] = useState<Session | null>(() =>
    outbox().conflictFor(itemKey),
  );
  // A change to review opens in the same place as a problem, and is a review of its own.
  const [review, setReview] = useState<OpenedReview | null>(null);
  const versions = useRef(new CodingSessionVersions(itemKey));
  if (versions.current.itemKey !== itemKey) {
    versions.current = new CodingSessionVersions(itemKey);
  }
  const staleAfterTimeout = useRef<boolean>(false);

  useEffect(() => {
    const unsubConflict = outbox().subscribe(() => {
      const conflict = outbox().conflictFor(itemKey);
      if (conflict) setSessionConflict(conflict);
    });
    const unsubApplied = outbox().onSessionApplied(itemKey, (applied) => {
      versions.current.confirm(applied.version ?? 0, outbox().list());
      if (!outbox().hasPendingCodingEvents(itemKey)) {
        staleAfterTimeout.current = false;
      }
      void updateCachedCodingSession(itemKey, applied);
      if (
        sessionRef.current &&
        applied.version !== undefined &&
        (sessionRef.current.version ?? 0) < applied.version
      ) {
        const bumped = { ...sessionRef.current, version: applied.version };
        sessionRef.current = bumped;
        setSession(bumped);
      }
    });
    return () => {
      unsubConflict();
      unsubApplied();
    };
  }, [itemKey]);

  const saver = useMemo(
    () =>
      new LatestSaver<Session>(
        async (next, keepalive) => {
          const queueOfflineUpdate = () => {
            const base = versions.current.nextBaseVersion(next.version ?? 1);
            const { coalesced } = outbox().enqueueCodingEvent(
              {
                kind: "session_updated",
                id: newId(),
                item: itemKey,
                base_version: base,
                session: { ...next, version: base },
                at: Date.now(),
              },
              false,
            );
            versions.current.recordOfflineUpdate(base, coalesced);
          };

          // Single owner per item: if the outbox still has pending events for this item, flush
          // them first so versions stay monotonic, or queue there rather than racing a parallel PUT.
          if (outbox().hasPendingCodingEvents(itemKey)) {
            if (connection.isOnline && !keepalive) {
              await outbox().flush();
            }
            if (outbox().hasPendingCodingEvents(itemKey)) {
              queueOfflineUpdate();
              return;
            }
          }

          if (staleAfterTimeout.current) {
            try {
              const refreshed = await codingApi.open(itemKey);
              versions.current.reset(
                refreshed.session.version ?? versions.current.confirmed,
                outbox().list(),
              );
              staleAfterTimeout.current = false;
            } catch {
              // Still unreachable; fall through to normal offline queueing below.
            }
          }
          const toSend: Session =
            versions.current.confirmed > 0
              ? { ...next, version: versions.current.confirmed }
              : next;
          try {
            const saved = await codingApi.saveSession(itemKey, toSend, keepalive);
            staleAfterTimeout.current = false;
            // This online PUT persisted the full latest session, so any unsent queued updates for
            // this item are superseded.
            outbox().dropUnsentSessionUpdates(itemKey);
            versions.current.reset(
              saved.session.version ?? versions.current.confirmed,
              outbox().list(),
            );
            // Only what's still unsaved is forgotten: a later change waits its turn.
            if (JSON.stringify(readUnsaved(itemKey)?.session) === JSON.stringify(next)) {
              writeUnsaved(itemKey, null);
            }
            void updateCachedCodingSession(itemKey, saved.session);
            if (sessionRef.current && saved.session.version !== undefined) {
              const bumped = { ...sessionRef.current, version: saved.session.version };
              sessionRef.current = bumped;
              setSession(bumped);
            }
            // Moving on to the review shows the solution, and every part.
            setOpened((current) =>
              current ? { ...current, solution: saved.solution, parts: saved.parts } : saved,
            );
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
              const current = (err.body as { current?: Session } | null)?.current;
              if (current) {
                setSessionConflict(current);
                return;
              }
            }
            if (err instanceof ConnectionError || err instanceof TimeoutError) {
              if (err instanceof TimeoutError) staleAfterTimeout.current = true;
              queueOfflineUpdate();
              return;
            }
            throw err;
          }
        },
        SAVE_DELAY_MS,
        () => {},
      ),
    [itemKey],
  );
  useEffect(() => {
    const leave = () => saver.flushOnExit();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
      saver.close();
    };
  }, [saver]);

  /** Changes the session, saving it on the device now and on the server shortly. */
  const change = useCallback(
    (update: (session: Session) => Session, now = false): Promise<void> => {
      const current = sessionRef.current;
      if (!current) return Promise.resolve();
      const next = update(current);
      sessionRef.current = next;
      setSession(next);
      writeUnsaved(itemKey, { session: next, at: Date.now() });
      void updateCachedCodingSession(itemKey, next);
      saver.schedule(next);
      return now ? saver.flush().catch(() => {}) : Promise.resolve();
    },
    [itemKey, saver],
  );

  const load = useCallback(
    async (solve = false) => {
      setError(null);
      setFinished(null);
      setSessionConflict(null);
      try {
        const item = await codingApi.openItem(itemKey, solve);
        if ("kind" in item) {
          setReview(item);
          return;
        }
        const fresh = item;
        versions.current.reset(fresh.session.version ?? 0, outbox().list());
        staleAfterTimeout.current = false;
        // What was done here while the server couldn't hear of it wins over what it has.
        const unsaved = solve ? null : readUnsaved(itemKey);
        const adopted =
          unsaved &&
          unsaved.at > fresh.session.updated_at &&
          sameSitting(unsaved.session, fresh.session)
            ? { ...unsaved.session, version: fresh.session.version ?? unsaved.session.version }
            : fresh.session;
        if (adopted !== fresh.session) saver.schedule(adopted);
        else writeUnsaved(itemKey, null);
        void updateCachedCodingSession(itemKey, adopted);
        for (const lang of fresh.languages) {
          void updateCachedCodingDraft(itemKey, lang.id, lang.code);
        }
        setOpened(fresh);
        sessionRef.current = adopted;
        setSession(adopted);
      } catch (e) {
        if (e instanceof ConnectionError || e instanceof TimeoutError) {
          const cached = await openCodingFromCache(itemKey, solve);
          if (cached) {
            const { opened: offlineOpened, createdSession } = cached;
            if (createdSession) {
              outbox().enqueueCodingEvent(
                {
                  kind: "session_opened",
                  id: newId(),
                  item: itemKey,
                  mode: createdSession.mode,
                  language: createdSession.language,
                  no_twist: createdSession.no_twist,
                  started_at: createdSession.started_at,
                },
                false,
              );
            }
            versions.current.reset(offlineOpened.session.version ?? 1, outbox().list());
            const unsaved = solve ? null : readUnsaved(itemKey);
            const adopted =
              unsaved &&
              unsaved.at > offlineOpened.session.updated_at &&
              sameSitting(unsaved.session, offlineOpened.session)
                ? unsaved.session
                : offlineOpened.session;
            setOpened(offlineOpened);
            sessionRef.current = adopted;
            setSession(adopted);
            return;
          }
        }
        setError(errorMessage(e));
      }
    },
    [itemKey, saver],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // A twist is posed once the review starts, and kept, so a reload shows the same one. If it
  // can't be, the review is a recall instead, which says why.
  const posing = useRef(false);
  useEffect(() => {
    if (session?.mode !== "twist" || !opened || opened.twist !== null || posing.current) return;
    posing.current = true;
    codingApi
      .twist(itemKey)
      .then(
        (fresh) => {
          versions.current.reset(
            fresh.session.version ?? versions.current.confirmed,
            outbox().list(),
          );
          void updateCachedCodingSession(itemKey, fresh.session);
          setOpened(fresh);
          sessionRef.current = fresh.session;
          setSession(fresh.session);
          writeUnsaved(itemKey, null);
        },
        (e: unknown) => {
          const why = isTransientNetworkError(e)
            ? "The server can't be reached to pose a twist, so recall how to solve it instead."
            : `Couldn't get a twist (${errorMessage(e)}), so recall how to solve it instead.`;
          void change((s) => ({ ...s, mode: "recall", step: "plan", no_twist: why }), true);
        },
      )
      .finally(() => {
        posing.current = false;
      });
  }, [session?.mode, opened, itemKey, change]);

  // Once it's being reviewed, the solution comes with the session's save online, or from the
  // on-device cache offline (strictly gated behind step === "review").
  useEffect(() => {
    if (session?.step !== "review" || !opened || opened.solution !== null) return;
    if (online) {
      void saver.flush().catch(() => {});
      return;
    }
    let cancelled = false;
    void getCachedCodingProblem(itemKey).then((cached) => {
      if (!cancelled && cached) {
        setOpened((current) =>
          current && sessionRef.current
            ? {
                ...current,
                solution: cached.solution,
                parts: cached.parts.slice(0, revealed(sessionRef.current, cached.parts.length)),
              }
            : current,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session?.step, opened?.solution, online, itemKey, saver]);

  const models = boot.models.discuss_models;
  const [model, setModel] = useState(
    boot.state.discuss_model && models.includes(boot.state.discuss_model)
      ? boot.state.discuss_model
      : (models[0] ?? ""),
  );
  const editor = useRef<CodeEditor | null>(null);
  const settings = useEditorSettings(boot.editor, editor);
  const keyboard = useCodeKeyboard(editor);
  const zen = useZen(setNotice);
  const coding = session?.step === "code" && finished === null;
  // Zen mode is only for writing the code: moving on from it, it's left.
  useEffect(() => {
    if (zen.on && !coding) zen.exit();
  }, [coding]);
  const enterZen = () => {
    setTutorOpen(false);
    // In the tap itself, as phones only open the keyboard for something the user started.
    keyboard.show(true);
    zen.enter();
  };
  const draftSaver = useRef<VersionedSaver | null>(null);
  const lastRun = useRef("");
  const tutor = useConversation(
    `workshop:tutor:${itemKey}`,
    (turns, replyId, onDelta, signal) =>
      codingApi.tutor(
        itemKey,
        {
          model,
          turns,
          // A project's files are the server's to show the tutor, with what's changed.
          code: openedRef.current?.project ? "" : (editor.current?.text() ?? ""),
          errors: editor.current?.diagnosticsText() ?? "",
          last_run: lastRun.current,
          file: sessionRef.current?.file ?? null,
          reply_id: replyId,
        },
        onDelta,
        signal,
      ),
    "Open a problem before asking about it.",
    () => change((s) => ({ ...s, hints: s.hints + 1 })),
  );

  const header = (
    <header class="top">
      <span class="header-start">
        <HomeButton onHome={onHome} />
        <CodingLink track={track} onList={onList} />
      </span>
      <span class="header-actions">
        {online ? null : (
          <span class="learn-sync offline" role="status">
            Offline
          </span>
        )}
        {coding ? <ZenButton onClick={enterZen} /> : null}
      </span>
    </header>
  );

  if (review) {
    return <ReviewView boot={boot} opened={review} onHome={onHome} onTrack={onTrack} />;
  }
  if (error && !opened) {
    return (
      <div class="learn">
        {header}
        <main class="learn-content">
          <p class="error-text">
            {online
              ? error
              : "Coding problems need the server, which can't be reached. Code to read works offline, from the Coding list."}
          </p>
          <button type="button" class="pill" onClick={() => void load()}>
            Try again
          </button>
        </main>
      </div>
    );
  }
  if (!opened || !session) {
    return (
      <div class="learn">
        {header}
        <main class="learn-content">
          <p class="muted">Loading…</p>
        </main>
      </div>
    );
  }

  const goTo = (step: StepName) => change((s) => ({ ...s, step }), true);
  const inProject = opened.project !== null;
  const next = () => {
    const after = stepAfter(session.mode, session.step, inProject);
    if (after) goTo(after);
  };
  const giveUp = () => change((s) => ({ ...s, step: "review" }), true);

  const steps = stepsFor(session.mode, inProject);
  const offlineBanner = online ? null : (
    <div class="banner offline" role="status">
      Offline · changes saved on this device
    </div>
  );
  const shared = {
    opened,
    session,
    change,
    online,
    openTutor: () => setTutorOpen(true),
    notify: setNotice,
  };

  const onCodeSaved = useCallback((language: Language, code: VersionedFile) => {
    setOpened((current) =>
      current
        ? {
            ...current,
            languages: current.languages.map((l) => (l.id === language ? { ...l, code } : l)),
          }
        : current,
    );
  }, []);

  const recordLocalSubmit = useCallback(
    async (
      passed: boolean,
      graded: Graded,
      buildNext: (baseVersion: number, now: number) => Session,
    ): Promise<Session> => {
      await saver.flush().catch(() => {});
      const now = Date.now();
      const currentSession = sessionRef.current;
      const baseVersion = versions.current.nextBaseVersion(currentSession?.version ?? 1);
      const nextSession = buildNext(baseVersion, now);
      versions.current.recordOfflineSubmit(baseVersion);
      await updateCachedCodingSession(itemKey, nextSession);
      outbox().enqueueCodingEvent({
        kind: "submitted",
        id: newId(),
        item: itemKey,
        base_version: baseVersion,
        passed,
        part: currentSession?.part ?? nextSession.part,
        graded,
        at: now,
      });
      sessionRef.current = nextSession;
      setSession(nextSession);
      writeUnsaved(itemKey, null);
      return nextSession;
    },
    [itemKey, saver],
  );

  const done = finished !== null || twistMarked !== null;
  const body = twistMarked ? (
    <TwistResult result={twistMarked} track={track} onHome={onHome} onList={onList} />
  ) : finished ? (
    <Finished
      finished={finished}
      mode={session.mode}
      track={track}
      onHome={onHome}
      onList={onList}
      onSolve={() => void load(true)}
    />
  ) : session.step === "twist" ? (
    <TwistStep
      {...shared}
      boot={boot}
      itemKey={itemKey}
      settings={settings}
      keyboard={keyboard}
      editor={editor}
      draftSaver={draftSaver}
      onCodeSaved={onCodeSaved}
      onMarked={(result) => {
        writeUnsaved(itemKey, null);
        setTwistMarked(result);
      }}
      onSolve={() => void load(true)}
    />
  ) : session.step === "understand" ? (
    <UnderstandStep {...shared} onNext={next} />
  ) : session.step === "plan" ? (
    <PlanStep
      {...shared}
      boot={boot}
      onNext={next}
      onSolve={session.mode === "recall" ? () => void load(true) : null}
    />
  ) : session.step === "code" || session.step === "test" ? (
    <CodeStep
      {...shared}
      itemKey={itemKey}
      settings={settings}
      keyboard={keyboard}
      zen={zen.on ? { onExit: zen.exit } : null}
      editor={editor}
      draftSaver={draftSaver}
      onCodeSaved={onCodeSaved}
      onLocalSubmit={recordLocalSubmit}
      onLocalOpened={setOpened}
      onRan={(summary) => {
        lastRun.current = summary;
      }}
      onReloaded={(fresh) => {
        versions.current.reset(
          fresh.session.version ?? versions.current.confirmed,
          outbox().list(),
        );
        const hints = Math.max(fresh.session.hints, sessionRef.current?.hints ?? 0);
        const adopted = hints > fresh.session.hints ? { ...fresh.session, hints } : fresh.session;
        void updateCachedCodingSession(itemKey, adopted);
        setOpened({ ...fresh, session: adopted });
        sessionRef.current = adopted;
        setSession(adopted);
        if (adopted.hints > fresh.session.hints) {
          writeUnsaved(itemKey, { session: adopted, at: Date.now() });
          saver.schedule(adopted);
        } else {
          saver.discard();
          writeUnsaved(itemKey, null);
        }
      }}
      onProject={(update) =>
        setOpened((current) =>
          current?.project ? { ...current, project: update(current.project) } : current,
        )
      }
      serverDictation={boot.server_dictation}
      onGiveUp={giveUp}
    />
  ) : (
    <ReviewStep
      {...shared}
      serverDictation={boot.server_dictation}
      onFinish={async (rating) => {
        const id = newId();
        const now = Date.now();
        if (online) {
          try {
            if (outbox().hasPendingCodingEvents(itemKey)) {
              await outbox().flush();
            }
            await saver.flush();
            const done = await codingApi.finish(itemKey, id, rating);
            writeUnsaved(itemKey, null);
            void updateCachedCodingSession(itemKey, null);
            setFinished(done);
            return;
          } catch (e) {
            if (!(e instanceof ConnectionError || e instanceof TimeoutError)) throw e;
          }
        }
        outbox().enqueueCodingEvent({
          kind: "finished",
          id,
          item: itemKey,
          base_version: null,
          started_at: session.started_at,
          rating,
          plan: session.plan,
          duration_ms: 0,
          answered_at: now,
        });
        writeUnsaved(itemKey, null);
        void updateCachedCodingSession(itemKey, null);
        setFinished({ due: null, retired: rating === "easy" });
      }}
    />
  );

  return (
    <div
      class={`learn coding-problem ${session.step === "code" || session.step === "test" ? "coding-at-code" : ""} ${zen.on ? "zen" : ""}`}
    >
      {header}
      <StepNav
        title={opened.label}
        steps={steps}
        current={session.step}
        label={(step) => STEP_LABELS[step]}
        reachable={(step) => reached(session.mode, session.step, step, inProject) && !done}
        onGo={goTo}
      />
      {opened.part_count > 1 && session.mode === "solve" && !done ? (
        <PartBar
          part={session.passed ? opened.part_count : session.part}
          count={opened.part_count}
          reviewing={session.step === "review"}
        />
      ) : null}
      {offlineBanner}
      {sessionConflict ? (
        <div class="banner" role="alert">
          <span>
            {sameSitting(sessionConflict, session)
              ? "This problem was edited on another device."
              : "This problem moved on on another device."}
          </span>
          {sameSitting(sessionConflict, session) ? (
            <button
              type="button"
              class="text-button"
              onClick={() => {
                versions.current.reset(
                  sessionConflict.version ?? versions.current.confirmed,
                  outbox().list(),
                );
                outbox().clearConflict(itemKey);
                setSessionConflict(null);
                if (sessionRef.current) {
                  // What's typed here wins; what only the server's tests change stays theirs.
                  const next = {
                    ...sessionRef.current,
                    plans: sessionConflict.plans,
                    passed: sessionConflict.passed,
                    submissions: sessionConflict.submissions,
                    version: sessionConflict.version ?? sessionRef.current.version,
                  };
                  sessionRef.current = next;
                  setSession(next);
                  saver.schedule(next);
                  void saver.flush().catch(() => {});
                }
              }}
            >
              Keep mine
            </button>
          ) : null}
          <button
            type="button"
            class="text-button"
            onClick={() => {
              outbox().clearConflict(itemKey);
              writeUnsaved(itemKey, null);
              setSessionConflict(null);
              // Opened again, with the parts and code as they now are.
              void load();
            }}
          >
            Load theirs
          </button>
        </div>
      ) : null}
      {notice ? (
        <div class="banner" role="status">
          <span>{notice}</span>
          <button type="button" class="text-button" onClick={() => setNotice(null)}>
            OK
          </button>
        </div>
      ) : null}
      {body}
      {tutorOpen ? (
        <TutorSheet
          conversation={tutor}
          models={models}
          model={model}
          onModel={setModel}
          online={online}
          onClose={() => setTutorOpen(false)}
        />
      ) : null}
    </div>
  );
}

interface StepProps {
  opened: Opened;
  session: Session;
  /** Changes the session; with `now`, saves it straight away, settling once it's tried. */
  change: (update: (session: Session) => Session, now?: boolean) => Promise<void>;
  online: boolean;
  openTutor: () => void;
  notify: (text: string) => void;
}

function TutorButton({ online, openTutor }: Pick<StepProps, "online" | "openTutor">) {
  return (
    <button type="button" class="pill" onClick={openTutor} disabled={!online}>
      {online ? "Ask the tutor" : "Tutor needs the server"}
    </button>
  );
}

/** Where the learner is in a problem in parts: which part, of how many, a mark for each. */
function PartBar({ part, count, reviewing }: { part: number; count: number; reviewing: boolean }) {
  return (
    <p class="coding-part-bar" role="status">
      <span class="coding-part-label">{reviewing ? `${count} parts` : partOf(part, count)}</span>
      <span class="coding-part-marks" aria-hidden="true">
        {Array.from({ length: count }, (_, at) => (
          <span
            key={at}
            class={`coding-part-mark ${at < part ? "done" : at === part && !reviewing ? "current" : ""}`}
          />
        ))}
      </span>
    </p>
  );
}

/** The part of a problem in parts the learner is on, if they're solving it, to mark as new. */
function newPart(opened: Opened, session: Session): number | null {
  return opened.part_count > 1 && session.mode === "solve" && session.step !== "review"
    ? session.part
    : null;
}

/**
 * The problem: its prompt, or for one in parts, each part seen so far, the one being worked on
 * marked as new and the earlier ones folded away.
 */
function Statement({
  opened,
  session,
  open = true,
}: {
  opened: Opened;
  session: Session;
  open?: boolean;
}) {
  const current = newPart(opened, session);
  const [first] = opened.parts;
  if (opened.part_count === 1 && first) {
    return (
      <details class="coding-statement" open={open}>
        <summary>The problem</summary>
        <Markdown text={first.prompt} class="learn-prompt" />
        {opened.source ? <p class="learn-source muted">Source: {opened.source}</p> : null}
      </details>
    );
  }
  return (
    <div class="coding-parts">
      {opened.parts.map((part, at) => {
        const changedBy = opened.parts.findIndex((later) => later.replaces.includes(at));
        const heading = `Part ${at + 1}${changedBy > at ? `, changed by part ${changedBy + 1}` : ""}`;
        return at === current ? (
          <section key={at} class="coding-part-new" aria-label={`Part ${at + 1}, new`}>
            <h2 class="coding-subheading">Part {at + 1} · New</h2>
            <Markdown text={part.prompt} class="learn-prompt" />
          </section>
        ) : (
          <details key={at} class="coding-statement" open={open && current === null && at === 0}>
            <summary>{heading}</summary>
            <Markdown text={part.prompt} class="learn-prompt" />
          </details>
        );
      })}
      {opened.source ? <p class="learn-source muted">Source: {opened.source}</p> : null}
    </div>
  );
}

/** A case's input and what it should print, or in API mode, its calls and what they return. */
function CaseIo({ api, known }: { api: Api | null; known: Case }) {
  if (api) return <pre class="coding-io calls">{showCalls(api, known.input, known.output)}</pre>;
  return (
    <>
      <pre class="coding-io">{known.input}</pre>
      <pre class="coding-io muted">{known.output}</pre>
    </>
  );
}

/**
 * Understanding the problem, or the part of it being started: working out by hand what its
 * first example prints, or in API mode, what its last call returns.
 */
function UnderstandStep({ opened, session, change, onNext }: StepProps & { onNext: () => void }) {
  const part = opened.parts[session.part];
  const example = part?.examples[0];
  const api = opened.api;
  const last = api && example ? lastCall(api, example.input, example.output) : null;
  const same = (typed: string) =>
    example ? (last ? sameReturn(last.returns, typed) : sameOutput(example.output, typed)) : false;
  const [prediction, setPrediction] = useState(session.prediction ?? "");
  const [checked, setChecked] = useState<boolean | null>(
    session.prediction !== null && example ? same(session.prediction) : null,
  );
  if (!example) return null;
  const answer = last ? pythonValue(JSON.parse(last.returns)) : example.output;
  return (
    <main class="learn-content">
      {session.part > 0 ? (
        <p class="coding-part-passed" role="status">
          Part {session.part} passed. Part {session.part + 1} adds to it, and your code is kept for
          it.
        </p>
      ) : null}
      {opened.part_count > 1 ? (
        <Statement opened={opened} session={session} />
      ) : (
        <Markdown text={part.prompt} class="learn-prompt" />
      )}
      <section class="coding-example" aria-label="Example 1">
        <h2 class="coding-subheading">{api ? "For these calls" : "For this input"}</h2>
        <pre class="coding-io">{api ? showCalls(api, example.input, null) : example.input}</pre>
      </section>
      <form
        class="learn-form"
        onSubmit={(event) => {
          event.preventDefault();
          setChecked(same(prediction));
          change((s) => ({ ...s, prediction }), true);
        }}
      >
        <label class="learn-question" for="coding-prediction">
          {last ? (
            <>
              What does <code>{last.call}</code> return, at the end?
            </>
          ) : (
            "What should it print?"
          )}
        </label>
        <textarea
          id="coding-prediction"
          class="learn-output"
          rows={2}
          autoComplete="off"
          autoCorrect="off"
          spellcheck={false}
          value={prediction}
          onInput={(event) => {
            setPrediction(event.currentTarget.value);
            setChecked(null);
          }}
        />
        {checked === null ? (
          <span class="learn-actions">
            <button type="button" class="pill" onClick={onNext}>
              Skip
            </button>
            <button type="submit" class="pill primary">
              Check
            </button>
          </span>
        ) : null}
      </form>
      {checked !== null ? (
        <section class={`learn-answer ${checked ? "right" : "wrong"}`} aria-label="Answer">
          <p class="learn-verdict">{checked ? "Right" : last ? "It returns:" : "It prints:"}</p>
          {checked ? null : <pre class="coding-io">{answer}</pre>}
          <button type="button" class="pill primary wide" onClick={onNext}>
            Next: plan
          </button>
        </section>
      ) : null}
    </main>
  );
}

/** Planning in words, typed or dictated, or recalling the plan for a problem solved before. */
function PlanStep({
  opened,
  session,
  change,
  online,
  openTutor,
  notify,
  boot,
  onNext,
  onSolve,
}: StepProps & { boot: Bootstrap; onNext: () => void; onSolve: (() => void) | null }) {
  const recall = session.mode === "recall";
  const setPlan = (plan: string) => change((s) => ({ ...s, plan }));
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<Marked | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [aloud, setAloud] = useState(false);
  // The grader marks the plan against the problem's approach, without giving it away, and what
  // it finds goes in the mistake log.
  const check = () => {
    setChecking(true);
    setCheckError(null);
    gradingApi
      .mark(opened.key, newId(), "plan", session.plan)
      .then(
        (reply) => setChecked(reply.marked),
        (e: unknown) => setCheckError(errorMessage(e)),
      )
      .finally(() => setChecking(false));
  };
  return (
    <main class="learn-content">
      {recall && session.no_twist ? (
        <p class="banner" role="status">
          {session.no_twist}
        </p>
      ) : null}
      <Statement opened={opened} session={session} open />
      <form
        class="learn-form"
        onSubmit={(event) => {
          event.preventDefault();
          onNext();
        }}
      >
        <label class="learn-question" for="coding-plan">
          {planQuestion(opened, session)}
        </label>
        <textarea
          id="coding-plan"
          class="coding-plan"
          rows={6}
          value={session.plan}
          placeholder={
            opened.project
              ? "Such as: which file and function, and what's going on there"
              : "Such as: what to keep track of, in what order, and what it costs"
          }
          onInput={(event) => setPlan(event.currentTarget.value)}
        />
        <DictateButton
          serverDictation={boot.server_dictation}
          onHeard={(text) => {
            const plan = sessionPlan(session.plan, text);
            change((s) => ({ ...s, plan }), true);
          }}
          onNotice={notify}
        />
        <span class="learn-actions">
          <TutorButton online={online} openTutor={openTutor} />
          <button
            type="button"
            class="pill"
            disabled={!online || checking || !session.plan.trim()}
            onClick={check}
          >
            {checking ? "Checking…" : "Check my plan"}
          </button>
          <button type="submit" class="pill primary">
            {recall
              ? opened.project
                ? "Compare with the explanation"
                : "Compare with the approach"
              : opened.project
                ? "Next: the code"
                : "Next: code"}
          </button>
        </span>
      </form>
      {checkError ? (
        <p class="error-text" role="alert">
          {checkError}
        </p>
      ) : null}
      {checked ? <MarkedView marked={checked} /> : null}
      {aloud ? (
        <ExplainAloud
          itemKey={opened.key}
          work="plan"
          question={recall ? "From memory, explain how you'd solve it" : "Explain your plan"}
          serverDictation={boot.server_dictation}
          onMarked={(_, heard) => {
            // Explained instead of written, what was said is the plan.
            if (!session.plan.trim()) change((s) => ({ ...s, plan: heard }), true);
          }}
        />
      ) : (
        <button type="button" class="learn-link" disabled={!online} onClick={() => setAloud(true)}>
          Explain your plan aloud, to be marked
        </button>
      )}
      {onSolve ? (
        <button type="button" class="learn-link" onClick={onSolve}>
          Solve it again instead
        </button>
      ) : null}
    </main>
  );
}

/**
 * The plan for work in a project, written beside its code once it's been read: what's wrong,
 * for a fix, or what to change, typed or dictated, and saved as it's written.
 */
function PlanBox({
  opened,
  session,
  change,
  serverDictation,
  notify,
}: Pick<StepProps, "opened" | "session" | "change" | "notify"> & { serverDictation: boolean }) {
  return (
    <div class="coding-plan-box">
      <label class="learn-question" for="coding-plan">
        {planQuestion(opened, session)}
      </label>
      <textarea
        id="coding-plan"
        class="coding-plan"
        rows={4}
        value={session.plan}
        placeholder="Such as: which file and function, and what's going on there"
        onInput={(event) => {
          const plan = event.currentTarget.value;
          void change((s) => ({ ...s, plan }));
        }}
      />
      <DictateButton
        serverDictation={serverDictation}
        onHeard={(text) => {
          const plan = sessionPlan(session.plan, text);
          void change((s) => ({ ...s, plan }), true);
        }}
        onNotice={notify}
      />
    </div>
  );
}

/** What planning asks: how to solve it, or in a project, what's wrong or what to change. */
function planQuestion(opened: Opened, session: Session): string {
  const task = opened.project?.task;
  if (session.mode === "recall") {
    if (task === "fix") return "From memory: what was wrong, and how did you fix it?";
    if (task) return "From memory: how did you refactor it, and then extend it?";
    return "From memory: how would you solve it?";
  }
  if (session.part > 0) {
    return `How will you change your code for part ${session.part + 1}? A few lines is plenty.`;
  }
  if (task === "fix") {
    return "What's wrong, and why does it give the symptom? A few lines is plenty.";
  }
  if (task) {
    return "What makes it hard to test, and how will you change it? A few lines is plenty.";
  }
  return "How will you solve it? A few lines is plenty.";
}

/** The plan with dictated words added on a line of their own. */
function sessionPlan(plan: string, heard: string): string {
  return plan.trim() ? `${plan.replace(/\s*$/, "")}\n${heard}` : heard;
}

/** Coding, in the editor, and running the examples; then submitting it to every test. */
function CodeStep({
  opened,
  session,
  change,
  online,
  openTutor,
  itemKey,
  settings,
  keyboard,
  zen,
  editor,
  draftSaver,
  onCodeSaved,
  onLocalSubmit,
  onLocalOpened,
  onRan,
  onReloaded,
  onProject,
  serverDictation,
  notify,
  onGiveUp,
}: StepProps & {
  itemKey: string;
  settings: EditorSettings;
  keyboard: CodeKeyboardState;
  /** Leaves zen mode, while in it: just the code and the keyboard. */
  zen: { onExit: () => void } | null;
  editor: { current: CodeEditor | null };
  draftSaver: { current: VersionedSaver | null };
  onCodeSaved: (language: Language, code: VersionedFile) => void;
  onLocalSubmit: (
    passed: boolean,
    graded: Graded,
    buildNext: (baseVersion: number, now: number) => Session,
  ) => Promise<Session>;
  onLocalOpened: (opened: Opened) => void;
  onRan: (summary: string) => void;
  onReloaded: (opened: Opened) => void;
  /** Changes the project as it's kept, as its files are saved or added. */
  onProject: (update: (project: OpenedProject) => OpenedProject) => void;
  serverDictation: boolean;
  onGiveUp: () => void;
}) {
  const [busy, setBusy] = useState<"running" | "submitting" | null>(null);
  const [ran, setRan] = useState<Graded | null>(null);
  const [ranEngine, setRanEngine] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [submittedEngine, setSubmittedEngine] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [hintsShown, setHintsShown] = useState(0);
  const [bundleTick, setBundleTick] = useState(0);
  const language = opened.languages.find((l) => l.id === session.language) ?? opened.languages[0];
  const testing = session.step === "test";

  useEffect(() => {
    void refreshCachedBundles();
    return subscribeCachedBundles(() => setBundleTick((t) => t + 1));
  }, []);

  const project = opened.project;
  // A project is only ever run on the server, which keeps its files.
  const hasLocalRunner =
    bundleTick >= 0 &&
    opened.api === null &&
    project === null &&
    language !== undefined &&
    isLanguageCachedSync(language.id);
  const mode = preferences.onDeviceMode.get();
  const canRun = online || hasLocalRunner;

  const keyboardShown = settings.ownKeyboard && keyboard.wanted && !testing;

  const runExamples = async () => {
    if (!language && !project) return;
    setBusy("running");
    setRunError(null);
    const hasLocal =
      opened.api === null &&
      project === null &&
      language !== undefined &&
      (await localRunner().isAvailable(language.id));
    const currentMode = preferences.onDeviceMode.get();
    const effectivelyOnline =
      online && (typeof navigator === "undefined" || navigator.onLine !== false);
    const backend = resolveRunBackend(currentMode, effectivelyOnline, hasLocal);
    const runLocally = async () => {
      if (!language) return;
      void draftSaver.current?.flush().catch(() => {});
      const code = editor.current?.text() ?? language.code.text;
      const cases = buildCodingExampleCases(opened.parts, session.part);
      const { graded, engine } = await localRunner().runCoding({
        languageId: language.id,
        code,
        cases,
        stopOnFailure: false,
        totalCases: cases.length,
      });
      setRan(graded);
      setRanEngine(engine);
      onRan(summarise(graded, opened.api, false));
      change((s) => ({ ...s, runs: s.runs + 1 }), true);
    };
    try {
      if (backend === "local") {
        await runLocally();
        return;
      }
      try {
        await draftSaver.current?.flush();
        const graded = await codingApi.run(itemKey, newId());
        setRan(graded);
        setRanEngine(null);
        onRan(summarise(graded, opened.api, project !== null));
        change((s) => ({ ...s, runs: s.runs + 1 }), true);
      } catch (e) {
        if (isTransientNetworkError(e) && currentMode === "automatic" && hasLocal) {
          await runLocally();
          return;
        }
        throw e;
      }
    } catch (e) {
      setRunError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!language && !project) return;
    keyboard.show(false);
    setBusy("submitting");
    setRunError(null);
    setSubmitted(null);
    setSubmittedEngine(null);
    const hasLocal =
      opened.api === null &&
      project === null &&
      language !== undefined &&
      (await localRunner().isAvailable(language.id));
    const effectivelyOnline =
      online && (typeof navigator === "undefined" || navigator.onLine !== false);
    const backend = resolveRunBackend(preferences.onDeviceMode.get(), effectivelyOnline, hasLocal);
    try {
      if (backend === "local" && language) {
        void draftSaver.current?.flush().catch(() => {});
        const cachedTests = await getCachedCodingTests(itemKey);
        if (!cachedTests) {
          setRunError(
            "Hidden tests aren't cached offline yet. Sync the Coding offline bundle while online first.",
          );
          return;
        }
        const code = editor.current?.text() ?? language.code.text;
        const cases = buildCodingSubmitCases(
          opened.parts,
          cachedTests.tests,
          cachedTests.oracleCases,
          session.part,
        );
        const { graded, timedOut, engine } = await localRunner().runCoding({
          languageId: language.id,
          code,
          cases,
          stopOnFailure: true,
          totalCases: cases.length,
        });
        if (timedOut) {
          // Local timeouts are inconclusive: never fail the submission or record a `too-slow` mistake.
          setRunError("Too slow to verify on this device; submit on the server.");
          return;
        }

        const passed =
          graded.outcome === "ran" &&
          graded.results.length === cases.length &&
          graded.results.every((r) => r.passed);
        const failure =
          graded.outcome === "ran" ? (graded.results.find((r) => !r.passed) ?? null) : null;
        const problem =
          graded.outcome === "build_failed"
            ? graded.errors
            : graded.outcome === "unavailable"
              ? graded.reason
              : failure
                ? describeRun(failure.run)
                : null;
        const ranCount =
          graded.outcome === "ran" ? graded.results.filter((r) => r.passed).length : 0;

        const advancingPart = passed && session.part < opened.part_count - 1;
        const nextSession = await onLocalSubmit(passed, graded, (baseVersion, now) =>
          advancingPart
            ? {
                ...session,
                submissions: session.submissions + 1,
                plans: [...session.plans, session.plan],
                part: session.part + 1,
                plan: "",
                prediction: null,
                step: "understand",
                updated_at: Math.max(now, session.updated_at),
                version: baseVersion + 1,
              }
            : {
                ...session,
                submissions: session.submissions + 1,
                passed,
                step: passed ? "review" : "test",
                updated_at: Math.max(now, session.updated_at),
                version: baseVersion + 1,
              },
        );

        const cachedProblem = await getCachedCodingProblem(itemKey);
        const nextParts = cachedProblem
          ? cachedProblem.parts.slice(0, revealed(nextSession, cachedProblem.parts.length))
          : opened.parts;
        const nextOpened: Opened = {
          ...opened,
          parts: nextParts,
          session: nextSession,
          solution:
            nextSession.step === "review"
              ? (cachedProblem?.solution ?? opened.solution)
              : opened.solution,
        };
        const result: Submitted = {
          passed,
          problem,
          failure,
          ran: ranCount,
          total: cases.length,
          opened: nextOpened,
        };
        setSubmitted(result);
        setSubmittedEngine(engine);
        onRan(result.problem ?? "Passed every test.");
        onLocalOpened(nextOpened);
        return;
      }

      // Saved first, so the server tests what's in the editor, at the step it's at.
      await Promise.all([
        change((s) => ({ ...s, step: "test" }), true),
        draftSaver.current?.flush(),
      ]);
      const result = await codingApi.submit(itemKey, newId());
      setSubmitted(result);
      setSubmittedEngine(null);
      onRan(result.problem ?? "Passed every test.");
      // The server moves a passing solution on to being reviewed.
      onReloaded(result.opened);
    } catch (e) {
      setRunError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!language && !project) return null;
  // The hints for the part being worked on.
  const partHints = opened.parts[session.part]?.hints ?? [];
  const hints = partHints.slice(0, hintsShown);
  return (
    <main class="coding-work">
      {zen ? <ZenExit onExit={zen.onExit} /> : null}
      {zen && settings.ownKeyboard && !keyboard.wanted ? (
        <ZenKeyboardButton onClick={() => keyboard.show(true)} />
      ) : null}
      {testing ? (
        <TestResults
          api={opened.api}
          project={project !== null}
          busy={busy === "submitting"}
          submitted={submitted}
          engine={submittedEngine}
          error={runError}
          canSubmit={canRun}
          onBack={() => change((s) => ({ ...s, step: "code" }), true)}
          onSubmit={() => void submit()}
          onCancel={() => localRunner().cancel()}
          onGiveUp={onGiveUp}
        />
      ) : (
        <>
          <div class="coding-toolbar">
            {language && opened.languages.length > 1 ? (
              <label class="coding-language">
                <span class="visually-hidden">Language</span>
                <select
                  value={language.id}
                  onChange={(event) => {
                    const id = event.currentTarget.value as Session["language"];
                    change((s) => ({ ...s, language: id }), true);
                  }}
                >
                  {opened.languages.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <details class="coding-statement compact">
              <summary>
                {opened.part_count > 1 ? partOf(session.part, opened.part_count) : "Problem"}
              </summary>
              <Statement opened={opened} session={session} open={false} />
              {project ? <ProjectTests opened={opened} part={session.part} /> : null}
              {project
                ? null
                : applying(opened.parts, session.part).map((at) =>
                    (opened.parts[at]?.examples ?? []).map((example, index) => {
                      const name =
                        opened.part_count > 1
                          ? `Part ${at + 1}'s example ${index + 1}`
                          : `Example ${index + 1}`;
                      return (
                        <section key={`${at}-${example.input}`} aria-label={name}>
                          <h3 class="coding-subheading">{name}</h3>
                          <CaseIo api={opened.api} known={example} />
                        </section>
                      );
                    }),
                  )}
              {session.plan.trim() && !project ? (
                <>
                  <h3 class="coding-subheading">Your plan</h3>
                  <p class="coding-plan-text">{session.plan}</p>
                </>
              ) : null}
            </details>
            {project ? (
              <details class="coding-statement compact">
                <summary>{project.task === "fix" ? "Diagnosis" : "Plan"}</summary>
                <PlanBox
                  opened={opened}
                  session={session}
                  change={change}
                  serverDictation={serverDictation}
                  notify={notify}
                />
              </details>
            ) : null}
            {partHints.length > hintsShown ? (
              <button
                type="button"
                class="text-button"
                onClick={() => {
                  setHintsShown((n) => n + 1);
                  change((s) => ({ ...s, hints: s.hints + 1 }));
                }}
              >
                {hintsShown === 0 ? "A hint" : "Another hint"}
              </button>
            ) : null}
            <button type="button" class="text-button" onClick={openTutor} disabled={!online}>
              Tutor
            </button>
          </div>
          {hints.length > 0 ? (
            <ol class="coding-hints" aria-label="Hints">
              {hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ol>
          ) : null}
          {project ? (
            <ProjectFiles
              key={session.part}
              itemKey={itemKey}
              project={project}
              file={session.file}
              onOpen={(path) => void change((s) => ({ ...s, file: path }), true)}
              onProject={onProject}
              settings={settings}
              editor={editor}
              saver={draftSaver}
              statusHost={keyboard.statusHost}
            />
          ) : language ? (
            <EditorPane
              key={language.id}
              itemKey={itemKey}
              file={languageFile(itemKey, language, (code) => onCodeSaved(language.id, code))}
              settings={settings}
              editor={editor}
              saver={draftSaver}
              statusHost={keyboard.statusHost}
            />
          ) : null}
          {ran || runError ? (
            <ExampleResults
              api={opened.api}
              project={project !== null}
              ran={ran}
              engine={ranEngine}
              error={runError}
              onDismiss={() => {
                setRan(null);
                setRanEngine(null);
                setRunError(null);
              }}
            />
          ) : null}
          {keyboardShown ? (
            <CodeKeyboard
              editor={editor}
              keyOffsets={settings.keyOffsets}
              onLower={() => keyboard.show(false)}
              statusHost={keyboard.placeStatus}
            />
          ) : zen ? null : (
            <footer class="coding-actions">
              <button
                type="button"
                class="pill"
                disabled={!canRun || busy !== null}
                onClick={() => void runExamples()}
              >
                {busy === "running"
                  ? "Running…"
                  : canRun
                    ? mode === "local" && hasLocalRunner
                      ? "Run examples (on device)"
                      : project
                        ? "Run tests"
                        : "Run examples"
                    : "Running needs the server"}
              </button>
              {busy !== null && hasLocalRunner ? (
                <button type="button" class="pill" onClick={() => localRunner().cancel()}>
                  Stop
                </button>
              ) : null}
              {canRun ? (
                <button
                  type="button"
                  class="pill primary"
                  disabled={busy !== null}
                  onClick={() => void submit()}
                >
                  Submit
                </button>
              ) : (
                <button type="button" class="pill primary" onClick={onGiveUp}>
                  Review approach
                </button>
              )}
              <KeyboardToggle
                // Workshop's own keyboard takes the footer's place, so here it's only ever down.
                shown={!settings.ownKeyboard && keyboard.wanted}
                onToggle={() => keyboard.show(settings.ownKeyboard || !keyboard.wanted)}
              />
            </footer>
          )}
        </>
      )}
    </main>
  );
}

/** What running on the examples did, in a line, for the tutor. */
function summarise(graded: Graded, api: Api | null, project: boolean): string {
  switch (graded.outcome) {
    case "build_failed":
      return `It didn't build:\n${graded.errors}`;
    case "unavailable":
      return graded.reason;
    case "ran":
      return graded.results
        .map((r) => {
          if (project) {
            const test = r.input.trim();
            return r.passed ? `${test}: passed` : `${test}: failed\n${r.run.stderr}`;
          }
          const verdict = `${describeCase(r.case)}: ${r.passed ? "passed" : describeRun(r.run)}`;
          const tooMuch = printedTooMuch(r.run);
          const output = api
            ? `\ncalls, and what they should return:\n${showCalls(api, r.input, r.expected)}\nwhat they returned:\n${showCalls(api, r.input, r.run.stdout, r.expected)}`
            : `\ninput:\n${r.input}${tooMuch ? `\n${tooMuch}` : `\nexpected:\n${r.expected}\ngot:\n${r.run.stdout}`}`;
          return `${verdict}${output}${r.run.stderr ? `\nstderr:\n${r.run.stderr}` : ""}`;
        })
        .join("\n\n");
  }
}

function ExampleResults({
  api,
  project,
  ran,
  engine,
  error,
  onDismiss,
}: {
  api: Api | null;
  /** Whether it ran a project's tests, rather than examples. */
  project: boolean;
  ran: Graded | null;
  engine: string | null;
  error: string | null;
  onDismiss: () => void;
}) {
  return (
    <section class="coding-results" aria-label="Examples run">
      <span class="coding-results-head">
        <h2 class="coding-subheading">
          {error
            ? "Couldn't run it"
            : ran?.outcome === "ran"
              ? project
                ? `${ran.results.filter((r) => r.passed).length} of ${ran.results.length} tests pass`
                : `${ran.results.filter((r) => r.passed).length} of ${ran.results.length} examples right`
              : ran?.outcome === "build_failed"
                ? "It doesn't build"
                : "Can't run it here"}
        </h2>
        <button type="button" class="text-button" onClick={onDismiss}>
          Close
        </button>
      </span>
      {engine ? <p class="muted small">Ran on device ({engine})</p> : null}
      {error ? <p class="error-text">{error}</p> : null}
      {ran?.outcome === "build_failed" ? (
        <pre class="coding-io error-text">{ran.errors}</pre>
      ) : null}
      {ran?.outcome === "unavailable" ? <p class="error-text">{ran.reason}</p> : null}
      {ran?.outcome === "ran"
        ? ran.results.map((result) =>
            project ? (
              <TestView key={JSON.stringify(result.case)} result={result} />
            ) : (
              <CaseView key={JSON.stringify(result.case)} api={api} result={result} />
            ),
          )
        : null}
    </section>
  );
}

function CaseView({ api, result }: { api: Api | null; result: CaseResult }) {
  const tooMuch = printedTooMuch(result.run);
  return (
    <article class={`coding-case ${result.passed ? "right" : "wrong"}`}>
      <p class="coding-case-head">
        {describeCase(result.case)}: {result.passed ? "right" : describeRun(result.run)}
      </p>
      {result.passed ? null : (
        <>
          {tooMuch ? <p class="error-text">{tooMuch}</p> : null}
          {api ? (
            <>
              <h3 class="coding-subheading">Calls, and what they should return</h3>
              <pre class="coding-io calls">{showCalls(api, result.input, result.expected)}</pre>
              {tooMuch ? null : (
                <>
                  <h3 class="coding-subheading">What yours returned</h3>
                  <pre class="coding-io calls">
                    {showCalls(api, result.input, result.run.stdout, result.expected)}
                  </pre>
                </>
              )}
            </>
          ) : (
            <>
              <h3 class="coding-subheading">Input</h3>
              <pre class="coding-io">{result.input}</pre>
              {tooMuch ? null : (
                <>
                  <h3 class="coding-subheading">Expected</h3>
                  <pre class="coding-io">{result.expected}</pre>
                  <h3 class="coding-subheading">Got</h3>
                  <pre class="coding-io">{result.run.stdout || "(nothing)"}</pre>
                </>
              )}
            </>
          )}
          {result.run.stderr.trim() ? (
            <pre class="coding-io error-text">{result.run.stderr}</pre>
          ) : null}
        </>
      )}
    </article>
  );
}

/** How one of a project's tests went: its name, and why it failed if it did. */
function TestView({ result }: { result: CaseResult }) {
  const test = testOf(result.input);
  const hidden = result.case.kind === "test";
  return (
    <article class={`coding-case ${result.passed ? "right" : "wrong"}`}>
      <p class="coding-case-head">
        {test ? testLabel(test.name) : result.input.trim()}:{" "}
        {result.passed
          ? "passes"
          : result.run.ending.status === "timed_out"
            ? "took too long"
            : "fails"}
      </p>
      <p class="muted small coding-test-where">
        {hidden ? "A hidden test, in " : ""}
        {test ? `${test.file}, ${test.name}` : null}
      </p>
      {result.passed || !result.run.stderr.trim() ? null : (
        <pre class="coding-io coding-traceback error-text">{result.run.stderr}</pre>
      )}
    </article>
  );
}

/** The tests a project's learner can run, by file, as far as they've reached. */
function ProjectTests({ opened, part }: { opened: Opened; part: number }) {
  const tests = applying(opened.parts, part).flatMap((at) =>
    (opened.parts[at]?.examples ?? []).map((example) => testOf(example.input)),
  );
  const files = [...new Set(tests.map((t) => t?.file ?? ""))].filter((f) => f !== "");
  return (
    <section aria-label="Tests">
      <h3 class="coding-subheading">Tests you can run</h3>
      {files.map((file) => (
        <div key={file}>
          <p class="coding-test-file">{file}</p>
          <ul class="coding-test-list">
            {tests
              .filter((t) => t?.file === file)
              .map((t) => (
                <li key={t?.name}>{t ? testLabel(t.name) : null}</li>
              ))}
          </ul>
        </div>
      ))}
      <p class="muted small">Hidden tests run too when you submit.</p>
    </section>
  );
}

/** Submitting: the hidden tests and the brute force's answers, and the first input it fails on. */
function TestResults({
  api,
  project,
  busy,
  submitted,
  engine,
  error,
  canSubmit,
  onBack,
  onSubmit,
  onCancel,
  onGiveUp,
}: {
  api: Api | null;
  /** Whether it's a project's tests. */
  project: boolean;
  busy: boolean;
  submitted: Submitted | null;
  engine: string | null;
  error: string | null;
  canSubmit: boolean;
  onBack: () => void;
  onSubmit: () => void;
  onCancel: () => void;
  onGiveUp: () => void;
}) {
  return (
    <div class="learn-content">
      {busy ? (
        <p class="muted" role="status">
          {project
            ? "Running every test, the hidden ones too…"
            : "Running the hidden tests, and comparing with a brute force on random inputs…"}
        </p>
      ) : null}
      {error ? <p class="error-text">{error}</p> : null}
      {submitted && !submitted.passed ? (
        <section class="coding-results" aria-label="Test results">
          <h2 class="coding-subheading">
            {submitted.total > 0
              ? `Passed ${submitted.ran} of ${submitted.total}, then went wrong`
              : "It didn't run"}
          </h2>
          {engine ? <p class="muted small">Ran on device ({engine})</p> : null}
          {submitted.failure ? (
            project ? (
              <TestView result={submitted.failure} />
            ) : (
              <CaseView api={api} result={submitted.failure} />
            )
          ) : (
            <pre class="coding-io error-text">{submitted.problem}</pre>
          )}
        </section>
      ) : null}
      {!busy && !submitted && !error ? (
        <p class="muted">Submit to run it on the hidden tests.</p>
      ) : null}
      <span class="learn-actions">
        <button type="button" class="pill" onClick={onBack} disabled={busy}>
          Back to the code
        </button>
        {busy ? (
          <button type="button" class="pill" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button type="button" class="pill primary" onClick={onSubmit} disabled={!canSubmit}>
            {submitted || error ? "Submit again" : "Submit"}
          </button>
        )}
      </span>
      <button type="button" class="learn-link" onClick={onGiveUp} disabled={busy}>
        Give up and see how it's solved
      </button>
    </div>
  );
}

const RATINGS: [Rating, string][] = [
  ["again", "Forgot"],
  ["hard", "Hard"],
  ["good", "Good"],
  ["easy", "Easy"],
];

/** Comparing with how it's meant to be solved, and saying how it went, which schedules it. */
function ReviewStep({
  opened,
  session,
  online,
  serverDictation,
  onFinish,
}: StepProps & { serverDictation: boolean; onFinish: (rating: Rating) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [aloud, setAloud] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const suggested = suggestedRating(session);
  const solution = opened.solution;
  const reference =
    solution?.reference.find((r) => r.language === session.language) ?? solution?.reference[0];
  const recall = session.mode === "recall";
  return (
    <main class="learn-content">
      {recall ? null : (
        <p class={`learn-verdict ${session.passed ? "right" : "wrong"}`}>
          {session.passed
            ? opened.part_count > 1
              ? `Solved: all ${opened.part_count} parts passed every test.`
              : "Solved: it passed every test."
            : opened.part_count > 1 && session.part > 0
              ? `Not solved this time: you got through ${session.part} of ${opened.part_count} parts.`
              : "Not solved this time."}
        </p>
      )}
      {opened.part_count > 1 ? <Statement opened={opened} session={session} open={false} /> : null}
      <section aria-label="Your plan">
        {session.plans.map((plan, at) => (
          <div key={at}>
            <h2 class="coding-subheading">Your plan for part {at + 1}</h2>
            <p class="coding-plan-text">{plan.trim() || "(none written)"}</p>
          </div>
        ))}
        <h2 class="coding-subheading">
          {session.plans.length > 0 ? `Your plan for part ${session.part + 1}` : "Your plan"}
        </h2>
        <p class="coding-plan-text">{session.plan.trim() || "(none written)"}</p>
        {recall && opened.previous_plan?.trim() ? (
          <>
            <h2 class="coding-subheading">Your plan last time</h2>
            <p class="coding-plan-text">{opened.previous_plan}</p>
          </>
        ) : null}
      </section>
      {solution?.project ? (
        <section aria-label="Changes">
          <details class="coding-statement" open>
            <summary>Your changes</summary>
            <ChangesView changes={solution.project.yours} label="Your changes" />
          </details>
          <details class="coding-statement">
            <summary>
              {opened.project?.task === "fix" ? "The reference fix" : "A reference solution"}
            </summary>
            <ChangesView changes={solution.project.reference} label="The reference's changes" />
          </details>
        </section>
      ) : null}
      {solution ? (
        <section aria-label="Approach">
          <h2 class="coding-subheading">
            {opened.project?.task === "fix" ? "What was wrong" : "How it's solved"}
          </h2>
          <Markdown text={solution.approach} />
          {reference ? (
            <details class="coding-statement">
              <summary>A solution</summary>
              <pre class="coding-io coding-reference">{reference.text}</pre>
            </details>
          ) : null}
          {solution.notes ? <Markdown text={solution.notes} class="muted" /> : null}
        </section>
      ) : (
        <p class="muted">
          {online
            ? "Loading how it's solved…"
            : "How it's solved comes from the server, once it can be reached."}
        </p>
      )}
      {recall ? null : aloud ? (
        <ExplainAloud
          itemKey={opened.key}
          work="explanation"
          question={
            opened.project?.task === "fix"
              ? "Explain what was wrong, and how your change puts it right"
              : opened.project
                ? "Explain what your changes separate, and why that makes it testable"
                : "Explain how your solution works, and what it costs"
          }
          serverDictation={serverDictation}
          onMarked={() => {}}
        />
      ) : (
        <button type="button" class="learn-link" disabled={!online} onClick={() => setAloud(true)}>
          Explain your solution aloud, to be marked
        </button>
      )}
      <p class="learn-question muted">{recall ? "Did your plan match?" : "How did it go?"}</p>
      <div class="learn-ratings">
        {RATINGS.map(([rating, label]) => (
          <button
            key={rating}
            type="button"
            class={`pill rating ${rating} ${rating === suggested ? "suggested" : ""}`}
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setProblem(null);
              onFinish(rating)
                .catch((e: unknown) => setProblem(errorMessage(e)))
                .finally(() => setSaving(false));
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {suggested ? (
        <p class="muted coding-hint">
          Suggested: {RATINGS.find(([r]) => r === suggested)?.[1]}, from how it went.
        </p>
      ) : null}
      <p class="muted coding-hint">Easy retires it: it won't come back unless you bring it back.</p>
      {online ? null : (
        <p class="muted">Offline: your rating will be saved on this device and synced later.</p>
      )}
      {problem ? <p class="error-text">{problem}</p> : null}
    </main>
  );
}

/**
 * Answering a twist on a problem solved before, posed for its review: explaining how the
 * approach would change, typed, dictated or aloud, or changing the code, for the grader to mark,
 * which is the review's rating.
 */
function TwistStep({
  opened,
  session,
  change,
  online,
  notify,
  boot,
  itemKey,
  settings,
  keyboard,
  editor,
  draftSaver,
  onCodeSaved,
  onMarked,
  onSolve,
}: StepProps & {
  boot: Bootstrap;
  itemKey: string;
  settings: EditorSettings;
  keyboard: CodeKeyboardState;
  editor: { current: CodeEditor | null };
  draftSaver: { current: VersionedSaver | null };
  onCodeSaved: (language: Language, code: VersionedFile) => void;
  onMarked: (result: TwistMarked) => void;
  onSolve: () => void;
}) {
  const [withCode, setWithCode] = useState(false);
  const [aloud, setAloud] = useState(false);
  const [marking, setMarking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const twist = opened.twist;
  const language = opened.languages.find((l) => l.id === session.language) ?? opened.languages[0];
  if (!twist) {
    return (
      <main class="learn-content">
        <p class="muted" role="status">
          The tutor is posing a twist on it…
        </p>
      </main>
    );
  }
  const answer = async (text: string, spoken: boolean) => {
    await draftSaver.current?.flush();
    return codingApi.answerTwist(itemKey, newId(), text, spoken, withCode);
  };
  const markWritten = () => {
    setMarking(true);
    setProblem(null);
    answer(session.plan, false)
      .then(onMarked, (e: unknown) => setProblem(errorMessage(e)))
      .finally(() => setMarking(false));
  };
  const keyboardShown = settings.ownKeyboard && keyboard.wanted;
  return (
    <main class="learn-content">
      <Statement opened={opened} session={session} open={false} />
      <section class="coding-twist" aria-label="Twist">
        <h2 class="coding-subheading">{TWIST_KINDS[twist.kind]}</h2>
        <Markdown text={twist.prompt} class="learn-prompt" />
      </section>
      <form
        class="learn-form"
        onSubmit={(event) => {
          event.preventDefault();
          markWritten();
        }}
      >
        <label class="learn-question" for="coding-twist-answer">
          How would you change your approach, and what would it cost?
        </label>
        <textarea
          id="coding-twist-answer"
          class="coding-plan"
          rows={5}
          value={session.plan}
          placeholder="A few lines is plenty: what changes, why it still works, and its cost"
          onInput={(event) => {
            const plan = event.currentTarget.value;
            change((s) => ({ ...s, plan }));
          }}
        />
        <DictateButton
          serverDictation={boot.server_dictation}
          onHeard={(text) => {
            const plan = sessionPlan(session.plan, text);
            change((s) => ({ ...s, plan }), true);
          }}
          onNotice={notify}
        />
        <span class="learn-actions">
          <button type="button" class="pill" onClick={() => setWithCode((on) => !on)}>
            {withCode ? "Leave the code as it is" : "Change your code too"}
          </button>
          <button
            type="submit"
            class="pill primary"
            disabled={!online || marking || !session.plan.trim()}
          >
            {marking ? "Marking…" : "Mark my answer"}
          </button>
        </span>
      </form>
      {withCode && language ? (
        <section class="coding-twist-code" aria-label="Your code">
          <EditorPane
            key={language.id}
            itemKey={itemKey}
            file={languageFile(itemKey, language, (code) => onCodeSaved(language.id, code))}
            settings={settings}
            editor={editor}
            saver={draftSaver}
            statusHost={keyboard.statusHost}
          />
          {keyboardShown ? (
            <CodeKeyboard
              editor={editor}
              keyOffsets={settings.keyOffsets}
              onLower={() => keyboard.show(false)}
              statusHost={keyboard.placeStatus}
            />
          ) : (
            <span class="learn-actions">
              <KeyboardToggle
                shown={!settings.ownKeyboard && keyboard.wanted}
                onToggle={() => keyboard.show(settings.ownKeyboard || !keyboard.wanted)}
              />
            </span>
          )}
          <p class="muted coding-hint">Your code goes to the grader with your answer.</p>
        </section>
      ) : null}
      {problem ? (
        <p class="error-text" role="alert">
          {problem}
        </p>
      ) : null}
      {online ? null : <p class="muted">Marking it needs the server.</p>}
      {aloud ? (
        <ExplainAloud
          itemKey={opened.key}
          work="explanation"
          question="Explain how you'd change your approach for the twist, and what it would cost"
          serverDictation={boot.server_dictation}
          mark={(heard) =>
            answer(heard, true).then((result) => {
              onMarked(result);
              return result;
            })
          }
          onMarked={() => {}}
        />
      ) : (
        <button type="button" class="learn-link" disabled={!online} onClick={() => setAloud(true)}>
          Explain your answer aloud, to be marked
        </button>
      )}
      <button type="button" class="learn-link" onClick={onSolve}>
        Solve it again instead
      </button>
    </main>
  );
}

/** How an answer to a twist was marked, which finished the review, and how it stands now. */
function TwistResult({
  result,
  track,
  onHome,
  onList,
}: {
  result: TwistMarked;
  track: OpenedTrack;
  onHome: () => void;
  onList: () => void;
}) {
  return (
    <main class="learn-content">
      <section class="learn-done" aria-label="Done">
        <h2>That's the review done</h2>
        <p class="muted">{comesBack(result, track)}</p>
      </section>
      <MarkedView marked={result.marked} />
      <section aria-label="A good answer">
        <h2 class="coding-subheading">What a good answer covers</h2>
        <Markdown text={result.notes} />
      </section>
      <details class="coding-statement">
        <summary>How the problem itself is solved</summary>
        <Markdown text={result.approach} />
      </details>
      <span class="learn-actions">
        <button type="button" class="pill" onClick={onHome}>
          Home
        </button>
        <button type="button" class="pill primary" onClick={onList}>
          {more(track)}
        </button>
      </span>
    </main>
  );
}

/** The Coding track, as a problem's own until it's open. */
const CODING_TRACK: OpenedTrack = { id: "coding", name: "Coding", icon: "code" };

/** What the button that goes back to a problem's track says. */
export function more(track: OpenedTrack): string {
  return track.id === "coding" ? "More coding" : `More in ${track.name}`;
}

/** When a problem comes back, or that it won't, once it's finished. */
export function comesBack(finished: FinishedReply, track: OpenedTrack): string {
  if (finished.retired) {
    const list = track.id === "coding" ? "the Coding list" : track.name;
    return `Retired: it won't come back. Bring it back from ${list} any time.`;
  }
  if (finished.due === null) return "Saved.";
  const days = Math.max(0, Math.round((finished.due - Date.now()) / 86_400_000));
  return days === 0
    ? "It comes back later today."
    : `It comes back in about ${days} ${days === 1 ? "day" : "days"}.`;
}

function Finished({
  finished,
  mode,
  track,
  onHome,
  onList,
  onSolve,
}: {
  finished: FinishedReply;
  mode: Session["mode"];
  track: OpenedTrack;
  onHome: () => void;
  onList: () => void;
  onSolve: () => void;
}) {
  return (
    <main class="learn-content">
      <section class="learn-done" aria-label="Done">
        <h2>That's it done</h2>
        <p class="muted">{comesBack(finished, track)}</p>
        <span class="learn-actions">
          <button type="button" class="pill" onClick={onHome}>
            Home
          </button>
          <button type="button" class="pill primary" onClick={onList}>
            {more(track)}
          </button>
        </span>
        {mode === "recall" ? (
          <button type="button" class="learn-link" onClick={onSolve}>
            Solve it again now
          </button>
        ) : null}
      </section>
    </main>
  );
}

/** Back to the list of the Coding track's items, from one of them. */
export function CodingLink({
  track = CODING_TRACK,
  onList,
}: {
  track?: OpenedTrack;
  onList: () => void;
}) {
  return (
    <button type="button" class="text-button track-link" onClick={onList}>
      <TrackIcon icon={track.icon} size={16} />
      {track.name}
    </button>
  );
}
