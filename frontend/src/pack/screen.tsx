import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { Loading, Page } from "../progress/page";
import { packApi } from "./api";
import { FlaggedCards } from "./flagged";
import { ImportForm } from "./import";
import "./pack.css";
import type { PackShown } from "./types";

/** The packs: items flagged as wrong, questions waiting as drafts, and adding more. */
export function PackScreen({ onHome }: { onHome: () => void }) {
  const [packs, setPacks] = useState<PackShown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    packApi.packs().then(setPacks, (e: unknown) => setError(errorMessage(e)));
  }, [attempt]);
  const drafts = packs?.flatMap((pack) => pack.drafts) ?? [];
  return (
    <Page title="Packs" onHome={onHome}>
      <FlaggedCards />
      {packs === null ? (
        <Loading error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : (
        <>
          <section aria-labelledby="drafts-heading" class="pack-section">
            <h2 id="drafts-heading" class="tracks-heading">
              Drafts
            </h2>
            {drafts.length === 0 ? (
              <p class="muted">No drafts. Questions you add wait here for the author.</p>
            ) : (
              <ul class="progress-list" aria-label="Drafts">
                {drafts.map((draft) => (
                  <li key={draft.path} class="progress-row">
                    <span>{draft.text}</span>
                    <span class="muted">
                      {draft.source ? `${draft.source} · ` : ""}
                      {draft.added ?? ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="import-heading" class="pack-section">
            <h2 id="import-heading" class="tracks-heading">
              Add a question
            </h2>
            <ImportForm packs={packs} onImported={() => setAttempt((n) => n + 1)} />
          </section>
        </>
      )}
    </Page>
  );
}
