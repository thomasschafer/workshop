import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { gradingApi } from "../grading/api";
import type { FlaggedCard } from "../grading/types";
import { newId } from "../learning/local";
import { Markdown } from "../learning/practice";
import { learning } from "../learning/sync";

/**
 * Cards flagged as wrong: each can be unflagged, checked by the grader, which clears the flag of
 * a card it finds right, and fixed as the grader proposes, once the fix is approved.
 */
export function FlaggedCards() {
  const [cards, setCards] = useState<FlaggedCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const load = () => {
    setError(null);
    return gradingApi.flagged().then(setCards, (e: unknown) => setError(errorMessage(e)));
  };
  useEffect(() => {
    void load();
  }, []);

  const act = (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    setError(null);
    action()
      .then(
        (message) => {
          setSaid(message);
          // So practice sees the flag's change.
          return learning().sync().then(load);
        },
        (e: unknown) => setError(errorMessage(e)),
      )
      .finally(() => setBusy(null));
  };

  const unflag = (key: string) =>
    act(key, async () => {
      learning().flag({ id: newId(), item: key, at: Date.now(), flagged: false });
      return "Unflagged, so it's back in practice.";
    });
  const review = (key: string) =>
    act(key, async () => {
      const { review, cleared } = await gradingApi.review(key);
      if (cleared) return `The grader found it right, so it's unflagged: ${review.explanation}`;
      return review.verdict === "wrong"
        ? "The grader proposes a fix, below."
        : `The grader found it right: ${review.explanation}`;
    });
  const fix = (key: string, approve: boolean) =>
    act(key, async () => {
      const { commit } = await gradingApi.fix(key, approve);
      if (!approve) return "Turned down; the card stays flagged.";
      return commit ? `Fixed, and committed to your pack as ${commit}.` : "Fixed in your pack.";
    });

  return (
    <section aria-labelledby="flagged-heading" class="pack-section">
      <h2 id="flagged-heading" class="tracks-heading">
        Flagged as wrong
      </h2>
      {said ? (
        <p role="status" class="muted">
          {said}
        </p>
      ) : null}
      {error ? (
        <p class="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {cards === null ? null : cards.length === 0 ? (
        <p class="muted">No cards are flagged.</p>
      ) : (
        <ul class="progress-list" aria-label="Flagged cards">
          {cards.map((card) => (
            <li key={card.key} class="progress-row">
              <Markdown text={card.prompt} />
              <Markdown text={card.answer} class="muted" />
              {card.note ? <span>You said: {card.note}</span> : null}
              {card.proposed?.review.fix ? (
                <section class="pack-fix" aria-label="Proposed fix">
                  <span class="progress-row-title">The grader's fix</span>
                  <span class="muted">{card.proposed.review.explanation}</span>
                  <Markdown text={card.proposed.review.fix.answer} />
                  {card.proposed.review.fix.explanation ? (
                    <Markdown text={card.proposed.review.fix.explanation} class="muted" />
                  ) : null}
                  <span class="learn-actions">
                    <button
                      type="button"
                      class="pill"
                      disabled={busy !== null}
                      onClick={() => fix(card.key, false)}
                    >
                      Turn down
                    </button>
                    <button
                      type="button"
                      class="pill primary"
                      disabled={busy !== null}
                      onClick={() => fix(card.key, true)}
                    >
                      Approve fix
                    </button>
                  </span>
                </section>
              ) : null}
              <span class="learn-actions">
                <button
                  type="button"
                  class="pill"
                  disabled={busy !== null}
                  onClick={() => unflag(card.key)}
                >
                  Unflag
                </button>
                <button
                  type="button"
                  class="pill"
                  disabled={busy !== null}
                  onClick={() => review(card.key)}
                >
                  {busy === card.key ? "Working…" : "Ask the grader"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
