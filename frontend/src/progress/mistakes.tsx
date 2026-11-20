import { useEffect, useState } from "preact/hooks";
import { ConnectionError, TimeoutError } from "../api";
import { errorMessage } from "../errors";
import { getSnapshot, putSnapshot } from "../offline/db";
import { outbox } from "../offline/outbox";
import { progressApi } from "./api";
import { Loading, Page } from "./page";
import type { ErrorType, Mistake, MistakeLog } from "./types";

const MISTAKES_SNAPSHOT_KEY = "mistakes";

const SOURCES: Record<Mistake["source"], string> = {
  answer: "Answer",
  submission: "Submission",
  grader: "Grader",
};

/** Applies queued offline mistake tags onto a cached log snapshot so the UI reflects them immediately. */
function applyPendingTags(log: MistakeLog): MistakeLog {
  const pending = outbox().list();
  if (pending.length === 0) return log;
  const overrides = new Map<string, string | null>();
  for (const event of pending) {
    if (event.kind === "mistake_tag") overrides.set(event.mistakeId, event.errorType);
  }
  if (overrides.size === 0) return log;
  const mistakes = log.mistakes.map((m) =>
    overrides.has(m.id) ? { ...m, confirmed: overrides.get(m.id) ?? null } : m,
  );
  const counts = new Map<string, number>();
  for (const m of mistakes) {
    const kind = m.confirmed ?? m.suggested;
    if (kind !== null) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const common = [...counts.entries()]
    .map(([error_type, count]) => ({ error_type, count }))
    .sort((a, b) => b.count - a.count || a.error_type.localeCompare(b.error_type));
  return { ...log, mistakes, common };
}

/**
 * The mistake log: what's gone wrong, most recent first, each tagged with the kind of mistake it
 * looks like, which the learner can confirm or change.
 */
export function MistakesScreen({ onHome }: { onHome: () => void }) {
  const [log, setLog] = useState<MistakeLog | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [kind, setKind] = useState<string>("");
  const [tagError, setTagError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let fetchedFresh = false;
    setError(null);
    setStale(false);
    const cacheReady = getSnapshot<MistakeLog>(MISTAKES_SNAPSHOT_KEY).then((cached) => {
      if (cancelled || !cached || fetchedFresh) return Boolean(cached);
      setLog(applyPendingTags(cached.value));
      return true;
    });
    outbox()
      .flush()
      .then(() => progressApi.mistakes())
      .then(
        (loaded) => {
          if (cancelled) return;
          fetchedFresh = true;
          const patched = applyPendingTags(loaded);
          setLog(patched);
          setStale(false);
          void putSnapshot(MISTAKES_SNAPSHOT_KEY, loaded);
        },
        async (e: unknown) => {
          const hasCached = await cacheReady;
          if (cancelled) return;
          if (hasCached) setStale(true);
          else setError(errorMessage(e));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const tag = (id: string, errorType: string | null) => {
    setTagError(null);
    progressApi.tag(id, errorType).then(
      (updated) => {
        setLog(updated);
        setStale(false);
        void putSnapshot(MISTAKES_SNAPSHOT_KEY, updated);
      },
      (e: unknown) => {
        if (e instanceof ConnectionError || e instanceof TimeoutError) {
          outbox().enqueueMistakeTag(id, errorType);
          setStale(true);
          setLog((current) => {
            if (!current) return current;
            const updated = applyPendingTags(current);
            void putSnapshot(MISTAKES_SNAPSHOT_KEY, updated);
            return updated;
          });
          return;
        }
        setTagError(errorMessage(e));
      },
    );
  };

  if (log === null) {
    return (
      <Page title="Mistakes" onHome={onHome}>
        <Loading error={error} onRetry={() => setAttempt((n) => n + 1)} />
      </Page>
    );
  }
  const name = (id: string | null) =>
    id === null ? "Untagged" : (log.error_types.find((t) => t.id === id)?.name ?? id);
  const shown = log.mistakes.filter(
    (m) => kind === "" || (m.confirmed ?? m.suggested ?? "untagged") === kind,
  );
  return (
    <Page title="Mistakes" onHome={onHome}>
      {stale ? (
        <p class="muted" role="status">
          Showing the last mistakes saved on this device; tag changes will sync when the server can
          be reached.
        </p>
      ) : null}
      {log.mistakes.length === 0 ? (
        <p class="empty">
          No mistakes yet. Wrong answers, failed submissions and what the grader finds are kept
          here.
        </p>
      ) : (
        <>
          <section aria-labelledby="common-heading">
            <h2 id="common-heading" class="tracks-heading">
              Most common
            </h2>
            <ul class="progress-counts">
              {log.common.map(({ error_type, count }) => (
                <li key={error_type}>
                  <span>{name(error_type)}</span>
                  <span class="muted">{count}</span>
                </li>
              ))}
            </ul>
            {log.focus.length > 0 ? (
              <p class="muted">
                Practice leans towards {log.focus.map((s) => log.skills[s] ?? s).join(", ")}, after
                recent mistakes.
              </p>
            ) : null}
          </section>
          <label class="progress-filter">
            Show
            <select value={kind} onChange={(event) => setKind(event.currentTarget.value)}>
              <option value="">Every kind</option>
              {log.error_types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              <option value="untagged">Untagged</option>
            </select>
          </label>
          {tagError ? (
            <p class="error-text" role="alert">
              {tagError}
            </p>
          ) : null}
          <ul class="progress-list" aria-label="Mistakes">
            {shown.map((mistake) => (
              <MistakeRow
                key={mistake.id}
                mistake={mistake}
                types={log.error_types}
                onTag={(errorType) => tag(mistake.id, errorType)}
              />
            ))}
          </ul>
        </>
      )}
    </Page>
  );
}

function MistakeRow({
  mistake,
  types,
  onTag,
}: {
  mistake: Mistake;
  types: ErrorType[];
  onTag: (errorType: string | null) => void;
}) {
  const current = mistake.confirmed ?? mistake.suggested;
  const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? id;
  const when = new Date(mistake.at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
  return (
    <li class="progress-row">
      <span class="progress-row-title">{mistake.label ?? mistake.item}</span>
      <span class="muted">
        {SOURCES[mistake.source]} · {when}
      </span>
      <span>{mistake.detail}</span>
      <span class="progress-tag">
        <label>
          <span class="visually-hidden">Kind of mistake</span>
          <select
            value={current ?? ""}
            onChange={(event) => onTag(event.currentTarget.value || null)}
          >
            {current === null ? <option value="">Choose a kind…</option> : null}
            {types.map((t) => (
              <option key={t.id} value={t.id} title={t.description}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {mistake.confirmed === null && mistake.suggested !== null ? (
          <>
            <span class="muted">Suggested</span>
            <button type="button" class="pill" onClick={() => onTag(mistake.suggested)}>
              Confirm
            </button>
          </>
        ) : mistake.confirmed !== null ? (
          <span class="muted">
            {mistake.suggested !== null && mistake.suggested !== mistake.confirmed
              ? `Suggested ${typeName(mistake.suggested)}`
              : "Confirmed"}
          </span>
        ) : null}
      </span>
    </li>
  );
}
