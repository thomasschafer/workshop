import { useEffect, useState } from "preact/hooks";
import { api, type Check, type Snippet } from "../api";

interface Props {
  snippets: Snippet[];
  editModel: string;
  commitMessage: string;
  onInsertSnippet: (snippet: Snippet) => void;
  keepScreenOn: boolean | null;
  onKeepScreenOn: (enabled: boolean) => void;
}

export function Settings({
  snippets,
  editModel,
  commitMessage,
  onInsertSnippet,
  keepScreenOn,
  onKeepScreenOn,
}: Props) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [sync, setSync] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const runChecks = () => {
    setChecks(null);
    setCheckError(null);
    api
      .doctor()
      .then(setChecks)
      .catch((e: unknown) => setCheckError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(runChecks, []);

  const commit = async () => {
    setSyncing(true);
    try {
      setSync((await api.gitSync(commitMessage)).summary);
    } catch (e) {
      setSync(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div class="settings">
      <section>
        <h2>Solutions repo</h2>
        <button type="button" class="pill" onClick={commit} disabled={syncing}>
          {syncing ? "Committing…" : "Commit and push"}
        </button>
        {sync ? <p class="muted">{sync}</p> : null}
      </section>

      <section>
        <h2>Snippets</h2>
        {snippets.length === 0 ? (
          <p class="muted">Add snippets to your config file, then say "snippet" and the name.</p>
        ) : (
          <div class="snippets">
            {snippets.map((s) => (
              <button type="button" key={s.name} class="chip" onClick={() => onInsertSnippet(s)}>
                {s.name}
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>Display</h2>
        {keepScreenOn === null ? (
          <p class="muted">This browser can't keep the screen on.</p>
        ) : (
          <label class="toggle">
            <input
              type="checkbox"
              checked={keepScreenOn}
              onChange={(e) => onKeepScreenOn((e.target as HTMLInputElement).checked)}
            />
            Keep the screen on while Workshop is open
          </label>
        )}
      </section>

      <section>
        <h2>Setup</h2>
        <p class="muted">Edits use {editModel}.</p>
        {checkError ? <p class="error-text">{checkError}</p> : null}
        {checks === null && !checkError ? <p class="muted">Checking…</p> : null}
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
        <button type="button" class="text-button" onClick={runChecks}>
          Check again
        </button>
      </section>

      <p class="muted small">Workshop is unofficial and not affiliated with Advent of Code.</p>
    </div>
  );
}
