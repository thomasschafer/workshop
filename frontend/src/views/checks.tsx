import { useEffect, useState } from "preact/hooks";
import { api, type Check } from "../api";

/** The results of `workshop doctor`, with a fix for anything that's wrong. */
export function Checks() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setChecks(null);
    setError(null);
    api
      .doctor()
      .then(setChecks)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(run, []);

  return (
    <>
      {error ? <p class="error-text">{error}</p> : null}
      {checks === null && !error ? <p class="muted">Checking…</p> : null}
      <ul class="checks">
        {checks?.map((c) => (
          <li key={c.name + c.detail} class={`check ${c.status}`}>
            <span class="mark">{c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗"}</span>
            <div>
              <div>
                {c.name}: <span class="muted">{c.detail}</span>
              </div>
              {c.fix ? <div class="fix">{c.fix}</div> : null}
            </div>
          </li>
        ))}
      </ul>
      <button type="button" class="text-button" onClick={run}>
        Check again
      </button>
    </>
  );
}
