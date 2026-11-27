import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { packApi } from "./api";
import type { AuthorStatus, Written } from "./types";

/** How often to ask how a run is going while it's running. */
const POLL_MS = 2000;

/**
 * The author: topping up the pack with new items, the items waiting for approval because the
 * writer and reviewer couldn't agree, and the questions it's asked.
 */
export function Author({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<AuthorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => packApi.author().then(setStatus, (e: unknown) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);
  const running = status?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      packApi.author().then(
        (next) => {
          setStatus(next);
          // A run that's finished may have changed the pack's drafts.
          if (!next.running) onChanged();
        },
        (e: unknown) => setError(errorMessage(e)),
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running]);

  const act = (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setSaid(null);
    action()
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  if (status === null) {
    return error ? <p class="error-text">{error}</p> : <p class="muted">Loading…</p>;
  }
  const last = status.last;
  return (
    <div class="pack-section">
      <p class="muted">
        {status.writer} writes up to {status.max_items} items for what you're weakest in, and{" "}
        {status.reviewer} solves each blind and reviews it. Each must pass its check.
      </p>
      <p class="muted">{status.reviewer_reason}</p>
      {status.schedule ? <ScheduleLine schedule={status.schedule} /> : null}
      {status.unavailable ? (
        <p class="muted">{status.unavailable}</p>
      ) : (
        <button
          type="button"
          class="pill primary"
          disabled={busy || running}
          onClick={() => act(() => packApi.topUp().then(setStatus))}
        >
          {running ? "Writing…" : "Top up"}
        </button>
      )}
      {error ? (
        <p class="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {said ? (
        <p class="muted" role="status">
          {said}
        </p>
      ) : null}
      {last && !running ? (
        <section class="pack-last" aria-label="Last run">
          {last.error ? (
            <p class="error-text">The last run couldn't finish: {last.error}</p>
          ) : last.report ? (
            <p>
              Last run: {count(last.report.accepted.length, "added")}
              {last.report.linked?.length ? `, ${count(last.report.linked.length, "linked")}` : ""}
              {last.commit ? ` in commit ${last.commit}` : ""},{" "}
              {count(last.report.queued.length, "waiting for approval")},{" "}
              {count(last.report.dropped.length, "left out")}.
            </p>
          ) : null}
          {last.report?.linked?.length ? (
            <details>
              <summary class="muted">Linked</summary>
              <ul>
                {last.report.linked.map((link) => (
                  <li key={link.path}>
                    {link.label} → {link.lesson}
                    {link.segment ? ` (segment ${link.segment})` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {last.report?.dropped.length ? (
            <details>
              <summary class="muted">Left out</summary>
              <ul>
                {last.report.dropped.map((item) => (
                  <li key={item.path}>
                    {item.label}: {item.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
      {status.lesson_requests?.length ? (
        <section aria-labelledby="lesson-requests-heading" class="pack-section">
          <h3 id="lesson-requests-heading" class="tracks-heading">
            Lesson requests
          </h3>
          <ul class="progress-list" aria-label="Lesson requests">
            {status.lesson_requests.map((req) => (
              <li key={req.item} class="progress-row">
                <span class="progress-row-title">{req.label}</span>
                {req.skills.length > 0 ? <span class="muted">{req.skills.join(", ")}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {status.questions.length > 0 ? (
        <section aria-labelledby="questions-heading" class="pack-section">
          <h3 id="questions-heading" class="tracks-heading">
            The author asks
          </h3>
          <ul class="progress-list">
            {status.questions.map((question) => (
              <QuestionRow
                key={question.id}
                text={question.text}
                answer={question.answer}
                busy={busy}
                onAnswer={(answer) =>
                  act(() =>
                    packApi.answer(question.id, answer).then((next) => {
                      setStatus(next);
                      setSaid("Thanks: the next run will see your answer.");
                    }),
                  )
                }
              />
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="queue-heading" class="pack-section">
        <h3 id="queue-heading" class="tracks-heading">
          Waiting for approval
        </h3>
        {status.queue.length === 0 ? (
          <p class="empty">Nothing is waiting.</p>
        ) : (
          <ul class="progress-list" aria-label="Waiting for approval">
            {status.queue.map(({ id, item }) => (
              <QueuedRow
                key={id}
                item={item}
                busy={busy}
                onDecide={(approve) =>
                  act(() =>
                    packApi.decide(id, approve).then(({ commit, status: next }) => {
                      setStatus(next);
                      setSaid(
                        approve
                          ? `Added to your pack${commit ? ` in commit ${commit}` : ""}.`
                          : "Turned down.",
                      );
                      onChanged();
                    }),
                  )
                }
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function count(n: number, what: string): string {
  return `${n} ${n === 1 ? "item" : "items"} ${what}`;
}

function QuestionRow({
  text,
  answer,
  busy,
  onAnswer,
}: {
  text: string;
  answer: string | null;
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [draft, setDraft] = useState(answer ?? "");
  return (
    <li class="progress-row">
      <span>{text}</span>
      <form
        class="pack-answer"
        onSubmit={(event) => {
          event.preventDefault();
          onAnswer(draft);
        }}
      >
        <label class="visually-hidden" for={`answer-${text}`}>
          Your answer
        </label>
        <input
          id={`answer-${text}`}
          type="text"
          value={draft}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" class="pill" disabled={busy || !draft.trim()}>
          {answer === null ? "Answer" : "Change"}
        </button>
      </form>
    </li>
  );
}

function QueuedRow({
  item,
  busy,
  onDecide,
}: {
  item: Written;
  busy: boolean;
  onDecide: (approve: boolean) => void;
}) {
  const bundled = item.items ?? [];
  const linked = item.linked ?? [];
  return (
    <li class="progress-row">
      <span class="progress-row-title">{item.label}</span>
      <span class="muted">
        {item.path}
        {bundled.length > 0 ? ` · with ${bundled.length} items` : ""}
        {linked.length > 0 ? ` · links ${linked.length} existing` : ""}
      </span>
      {item.reason ? <span>{item.reason}</span> : null}
      <details>
        <summary class="muted">The item, and what they said</summary>
        {Object.entries(item.files).map(([path, text]) => (
          <pre key={path} class="pack-file">
            {text}
          </pre>
        ))}
        {bundled.map((child) => (
          <div key={child.path}>
            <p class="muted">{child.path}</p>
            {Object.entries(child.files).map(([path, text]) => (
              <pre key={path} class="pack-file">
                {text}
              </pre>
            ))}
          </div>
        ))}
        <ol class="pack-transcript">
          {item.transcript.map((turn, index) => (
            <li key={`${turn.who}-${index}`}>
              <span class="progress-row-title">
                {turn.who === "writer" ? "Writer" : "Reviewer"}
              </span>{" "}
              {turn.text}
            </li>
          ))}
        </ol>
      </details>
      <span class="learn-actions">
        <button type="button" class="pill" disabled={busy} onClick={() => onDecide(false)}>
          Turn down
        </button>
        <button type="button" class="pill primary" disabled={busy} onClick={() => onDecide(true)}>
          Approve
        </button>
      </span>
    </li>
  );
}

/** When the server next runs the author by itself. */
function ScheduleLine({ schedule }: { schedule: NonNullable<AuthorStatus["schedule"]> }) {
  const next =
    schedule.next_at <= Date.now()
      ? "due now"
      : new Date(schedule.next_at).toLocaleString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        });
  return (
    <p class="muted">
      Runs by itself {schedule.every}
      {schedule.after ? `, after ${schedule.after}` : ""}. Next run: {next}.
    </p>
  );
}
