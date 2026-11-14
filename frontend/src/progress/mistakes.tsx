import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { progressApi } from "./api";
import { Loading, Page } from "./page";
import type { ErrorType, Mistake, MistakeLog } from "./types";

const SOURCES: Record<Mistake["source"], string> = {
  answer: "Answer",
  submission: "Submission",
  grader: "Grader",
};

/**
 * The mistake log: what's gone wrong, most recent first, each tagged with the kind of mistake it
 * looks like, which the learner can confirm or change.
 */
export function MistakesScreen({ onHome }: { onHome: () => void }) {
  const [log, setLog] = useState<MistakeLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [kind, setKind] = useState<string>("");
  const [tagError, setTagError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    progressApi.mistakes().then(setLog, (e: unknown) => setError(errorMessage(e)));
  }, [attempt]);

  const tag = (id: string, errorType: string | null) => {
    setTagError(null);
    progressApi.tag(id, errorType).then(setLog, (e: unknown) => setTagError(errorMessage(e)));
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
      {log.mistakes.length === 0 ? (
        <p class="muted">
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
