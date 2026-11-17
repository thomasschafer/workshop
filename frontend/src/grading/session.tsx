import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { useConnection } from "../hooks/useConnection";
import { newId } from "../learning/local";
import { Markdown } from "../learning/practice";
import { LatestSaver } from "../saver";
import { DictateButton } from "../views/dictate";
import { StepNav } from "../views/steps";
import { gradingApi } from "./api";
import { MarkedView } from "./marked";
import type {
  Component,
  DesignEdit,
  DesignMarked,
  DesignOpened,
  DesignSession,
  SessionTurn,
  Stage,
} from "./types";

/** The stages' names in the list of them, short enough to fit a phone. */
const SHORT: Record<Stage, string> = {
  requirements: "Requirements",
  scale: "Scale",
  outline: "Outline",
  deep_dive: "Deep dive",
  trade_offs: "Trade-offs",
};

/** How long typing pauses before it's saved. */
const SAVE_DELAY_MS = 600;

/** Changes saved on this device that the server hasn't confirmed yet, such as while offline. */
interface Unsaved {
  edit: DesignEdit;
  at: number;
}

const unsavedKey = (key: string) => `workshop:unsaved:design-session:${key}`;

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

function editOf(session: DesignSession): DesignEdit {
  const notes: DesignEdit["notes"] = {};
  for (const [stage, work] of Object.entries(session.work)) {
    if (work) notes[stage as Stage] = work.notes;
  }
  return {
    stage: session.stage,
    notes,
    components: session.components,
    deep_dive: session.deep_dive,
  };
}

/** Why a component list can't be saved as it is, if it can't. */
function componentProblem(components: Component[]): string | null {
  const seen = new Set<string>();
  for (const component of components) {
    const name = component.name.trim().toLowerCase();
    if (!name) continue;
    if (seen.has(name)) return `Two components are called "${component.name.trim()}".`;
    seen.add(name);
  }
  return null;
}

/** What's sent to be saved: components still being named are left out until they have one. */
function toSave(edit: DesignEdit): DesignEdit {
  const components = edit.components.filter((c) => c.name.trim());
  const deep_dive =
    edit.deep_dive && components.some((c) => c.name.trim() === edit.deep_dive?.trim())
      ? edit.deep_dive
      : null;
  return { ...edit, components, deep_dive };
}

/**
 * The edits that save `edit` when the server has reached `reached`. The server takes a session
 * one stage on at a time, but stages moved through while a save was on its way, or offline, are
 * only in the latest edit, so each stage between is sent first, with the notes up to it.
 */
function inTurn(edit: DesignEdit, reached: Stage, stages: readonly Stage[]): DesignEdit[] {
  const index = (stage: Stage) => {
    const at = stages.indexOf(stage);
    if (at === -1) throw new Error(`${stage} isn't one of the session's stages`);
    return at;
  };
  const edits: DesignEdit[] = [];
  for (let at = index(reached) + 1; at < index(edit.stage); at++) {
    const upTo = stages.slice(0, at + 1);
    const notes = Object.fromEntries(
      Object.entries(edit.notes).filter(([stage]) => upTo.includes(stage as Stage)),
    );
    edits.push({ ...edit, stage: upTo[at] as Stage, notes });
  }
  edits.push(edit);
  return edits;
}

/**
 * A design prompt worked through as a session, in stages: clarifying the requirements,
 * estimating the scale, outlining the design, going into one component, and its trade-offs
 * and failure modes. While finding out the requirements and the scale, the learner asks the
 * coach, which answers from a brief they see only once it's marked; at the later stages, the
 * coach asks them follow-up questions. Everything's saved as it's written, so the learner can
 * stop at any stage and carry on later, and the grader marks the whole session at the end.
 */
export function DesignSessionView({
  opened,
  session: initial,
  serverDictation,
  onDone,
}: {
  opened: DesignOpened;
  session: DesignSession;
  serverDictation: boolean;
  onDone: () => void;
}) {
  const key = opened.key;
  const stageIds = useMemo(() => opened.stages.map((s) => s.id), [opened.stages]);
  const online = useConnection();
  const [session, setSessionState] = useState(initial);
  // As the server last said it was, for saves to know which stages it's reached.
  const sessionRef = useRef(initial);
  const setSession = (saved: DesignSession) => {
    sessionRef.current = saved;
    setSessionState(saved);
  };
  const [edit, setEdit] = useState<DesignEdit>(() => {
    // What was done here while the server couldn't hear of it wins over what it has.
    const unsaved = readUnsaved(key);
    return unsaved && unsaved.at > initial.updated_at ? unsaved.edit : editOf(initial);
  });
  const editRef = useRef(edit);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [result, setResult] = useState<DesignMarked | null>(null);

  const saver = useMemo(
    () =>
      new LatestSaver<DesignEdit>(
        async (next, keepalive) => {
          let saved = sessionRef.current;
          for (const edit of inTurn(next, saved.reached, stageIds)) {
            saved = await gradingApi.saveDesign(key, edit, keepalive);
            sessionRef.current = saved;
          }
          if (JSON.stringify(toSave(editRef.current)) === JSON.stringify(next)) {
            writeUnsaved(key, null);
          }
          setSaveError(null);
          setSession(saved);
        },
        SAVE_DELAY_MS,
        setSaveError,
      ),
    [key, stageIds],
  );
  useEffect(() => {
    // Changes kept on the device from before are sent as soon as it opens.
    if (readUnsaved(key)) saver.schedule(toSave(editRef.current));
    const leave = () => saver.flushOnExit();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [saver]);

  const problem = componentProblem(edit.components);
  const change = (update: (edit: DesignEdit) => DesignEdit, now = false): Promise<void> => {
    const next = update(editRef.current);
    editRef.current = next;
    setEdit(next);
    writeUnsaved(key, { edit: next, at: Date.now() });
    // Two components with the same name wait until one's renamed.
    if (componentProblem(next.components)) return Promise.resolve();
    saver.schedule(toSave(next));
    return now ? saver.flush().catch(() => {}) : Promise.resolve();
  };

  const stages = opened.stages;
  const at = stages.findIndex((s) => s.id === edit.stage);
  const stage = stages[at] ?? stages[0];
  if (!stage) throw new Error("a design session has no stages");
  const next = stages[at + 1] ?? null;
  const reachedAt = stages.findIndex((s) => s.id === session.reached);
  const turns: SessionTurn[] = session.work[stage.id]?.turns ?? [];
  const notes = edit.notes[stage.id] ?? "";

  const goTo = (to: Stage) => {
    setReply("");
    setAskError(null);
    void change((e) => ({ ...e, stage: to }), true);
  };

  const ask = async () => {
    setAsking(true);
    setAskError(null);
    try {
      // So the coach sees what's just been written.
      await saver.flush();
      const answer = reply.trim() || null;
      setSession(await gradingApi.coach(key, stage.id, answer));
      setReply("");
    } catch (e) {
      setAskError(errorMessage(e));
    } finally {
      setAsking(false);
    }
  };

  const finish = async () => {
    setMarking(true);
    setMarkError(null);
    try {
      await saver.flush();
      const marked = await gradingApi.finishDesign(key, newId());
      writeUnsaved(key, null);
      setResult(marked);
    } catch (e) {
      setMarkError(errorMessage(e));
    } finally {
      setMarking(false);
    }
  };

  if (result) {
    return (
      <>
        <h2 class="design-stage-name">Marked</h2>
        <MarkedView marked={result.marked} />
        <details>
          <summary class="muted">The rubric</summary>
          <ul>
            {result.rubric.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </details>
        {result.brief ? (
          <section class="design-brief" aria-label="The brief">
            <h3 class="tracks-heading">The brief your questions were answered from</h3>
            <Markdown text={result.brief} />
          </section>
        ) : null}
        <button type="button" class="pill primary wide" onClick={onDone}>
          Done
        </button>
      </>
    );
  }

  // Where the learner asks, the coach answers; elsewhere, the coach asks and the learner answers.
  const asks = stage.learner_asks;
  const last = turns[turns.length - 1]?.speaker ?? null;
  const lastFromCoach = last === "coach";
  // A question the coach couldn't answer, such as when it couldn't be reached, waits for it.
  const unanswered = asks && last === "learner";
  return (
    <>
      <StepNav
        title={opened.label}
        steps={stages.map((s) => s.id)}
        current={stage.id}
        label={(id) => SHORT[id]}
        reachable={(id) => stages.findIndex((s) => s.id === id) <= reachedAt}
        onGo={goTo}
      />
      <details class="coding-statement" open={stage.id === "requirements"}>
        <summary>The prompt</summary>
        <Markdown text={opened.prompt} class="learn-prompt" />
      </details>
      <section class="design-stage" aria-label={stage.name}>
        <h2 class="design-stage-name">
          {at + 1}. {stage.name}
        </h2>
        <p class="muted design-task">{stage.task}</p>
        {stage.id === "outline" ? (
          <ComponentList
            components={edit.components}
            onChange={(components) => change((e) => ({ ...e, components }))}
          />
        ) : stage.id === "deep_dive" ? (
          <DeepDiveChoice
            edit={edit}
            onChange={(deep_dive) => change((e) => ({ ...e, deep_dive }))}
          />
        ) : null}
        {problem ? (
          <p class="error-text" role="alert">
            {problem}
          </p>
        ) : null}
        <label class="learn-question" for="design-notes">
          Your notes
        </label>
        <textarea
          id="design-notes"
          class="written"
          value={notes}
          onInput={(event) => {
            const text = event.currentTarget.value;
            void change((e) => ({ ...e, notes: { ...e.notes, [stage.id]: text } }));
          }}
        />
        <DictateButton
          serverDictation={serverDictation}
          onHeard={(heard) => {
            void change((e) => {
              const before = e.notes[stage.id] ?? "";
              const text = before.trim() ? `${before.replace(/\s*$/, "")}\n${heard}` : heard;
              return { ...e, notes: { ...e.notes, [stage.id]: text } };
            }, true);
          }}
          onNotice={setNotice}
        />
        {notice ? <p class="muted">{notice}</p> : null}
      </section>
      <section class="design-coach" aria-label="Coach">
        <h3 class="tracks-heading">Coach</h3>
        {turns.length === 0 ? (
          <p class="muted">
            {asks
              ? "Ask the coach what you need to know. It answers from a brief, which you'll see once the session's marked."
              : "When you've written something, the coach asks follow-up questions about it."}
          </p>
        ) : (
          <ol class="design-turns">
            {turns.map((turn) => (
              <li key={`${turn.at}-${turn.speaker}`} class={`design-turn ${turn.speaker}`}>
                {turn.text}
              </li>
            ))}
          </ol>
        )}
        {asks || lastFromCoach ? (
          <>
            <label class="muted" for="design-reply">
              {asks ? "Your question" : "Your answer to the coach"}
            </label>
            <textarea
              id="design-reply"
              class="written design-reply"
              value={reply}
              readOnly={asking}
              onInput={(event) => setReply(event.currentTarget.value)}
            />
            <DictateButton
              serverDictation={serverDictation}
              onHeard={(heard) =>
                setReply((sofar) => (sofar.trim() ? `${sofar.trimEnd()} ${heard}` : heard))
              }
              onNotice={setNotice}
            />
          </>
        ) : null}
        {askError ? (
          <p class="error-text" role="alert">
            {askError}
          </p>
        ) : null}
        <button
          type="button"
          class="pill"
          disabled={
            asking ||
            !online ||
            (asks ? !reply.trim() && !unanswered : lastFromCoach && !reply.trim())
          }
          onClick={() => void ask()}
        >
          {asking
            ? "The coach is thinking…"
            : asks
              ? unanswered && !reply.trim()
                ? "Get the coach's answer"
                : "Ask the coach"
              : lastFromCoach
                ? "Answer the coach"
                : "Ask the coach"}
        </button>
      </section>
      {saveError ? (
        <p class="muted" role="status">
          Not saved yet: {saveError}. It's kept on this device, and saved once the server can be
          reached.
        </p>
      ) : null}
      {markError ? (
        <p class="error-text" role="alert">
          {markError}
        </p>
      ) : null}
      <span class="learn-actions">
        <button type="button" class="pill" onClick={onDone}>
          Stop here for now
        </button>
        {next ? (
          <button type="button" class="pill primary" onClick={() => goTo(next.id)}>
            Next: {next.name.toLowerCase()}
          </button>
        ) : (
          <button
            type="button"
            class="pill primary"
            disabled={marking || !online || problem !== null}
            onClick={() => void finish()}
          >
            {marking ? "Marking…" : "Finish and mark it"}
          </button>
        )}
      </span>
    </>
  );
}

/** The components of the design, sketched as a list: what each does, and what it talks to. */
function ComponentList({
  components,
  onChange,
}: {
  components: Component[];
  onChange: (components: Component[]) => void;
}) {
  const update = (at: number, changed: Partial<Component>) =>
    onChange(components.map((c, i) => (i === at ? { ...c, ...changed } : c)));
  return (
    <section class="design-components" aria-label="Components">
      <h3 class="tracks-heading">Components</h3>
      {components.length === 0 ? (
        <p class="muted">List the parts of the design, such as services, stores and queues.</p>
      ) : (
        <ol class="design-component-list">
          {components.map((component, at) => (
            // A row is its place in the list: each input shows what's in the list there.
            <li key={at} class="design-component">
              <input
                type="text"
                aria-label={`Component ${at + 1}`}
                placeholder="Name, such as Cache"
                value={component.name}
                onInput={(event) => update(at, { name: event.currentTarget.value })}
              />
              <input
                type="text"
                aria-label={`What component ${at + 1} does`}
                placeholder="What it does"
                value={component.role}
                onInput={(event) => update(at, { role: event.currentTarget.value })}
              />
              <TalksTo
                at={at}
                names={component.talks_to}
                onChange={(talks_to) => update(at, { talks_to })}
              />
              <button
                type="button"
                class="text-button"
                onClick={() => onChange(components.filter((_, i) => i !== at))}
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        class="pill"
        onClick={() => onChange([...components, { name: "", role: "", talks_to: [] }])}
      >
        Add a component
      </button>
    </section>
  );
}

/** What a component talks to, typed as names separated by commas. */
function TalksTo({
  at,
  names,
  onChange,
}: {
  at: number;
  names: string[];
  onChange: (names: string[]) => void;
}) {
  // Kept as typed, so a comma just typed isn't taken away before the next name, unless the
  // names change otherwise, such as when a row above is removed.
  const [text, setText] = useState(() => names.join(", "));
  useEffect(() => {
    if (JSON.stringify(parseNames(text)) !== JSON.stringify(names)) setText(names.join(", "));
  }, [names]);
  return (
    <input
      type="text"
      aria-label={`What component ${at + 1} talks to`}
      placeholder="Talks to, such as API, Store"
      value={text}
      onInput={(event) => {
        const typed = event.currentTarget.value;
        setText(typed);
        onChange(parseNames(typed));
      }}
    />
  );
}

function parseNames(text: string): string[] {
  return text
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function DeepDiveChoice({
  edit,
  onChange,
}: {
  edit: DesignEdit;
  onChange: (name: string | null) => void;
}) {
  const named = edit.components.filter((c) => c.name.trim());
  if (named.length === 0) {
    return (
      <p class="muted">
        Add components while outlining the design, then choose one of them to go into here.
      </p>
    );
  }
  return (
    <label class="design-deep-dive">
      <span class="learn-question">The component to go into</span>
      <select
        value={edit.deep_dive ?? ""}
        onChange={(event) => onChange(event.currentTarget.value || null)}
      >
        <option value="">Choose one</option>
        {named.map((c) => (
          <option key={c.name} value={c.name.trim()}>
            {c.name.trim()}
          </option>
        ))}
      </select>
    </label>
  );
}
