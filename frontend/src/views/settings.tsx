import { useState } from "preact/hooks";
import { api, type ModelsState, type Snippet } from "../api";
import { Checks } from "./checks";
import { ModelsSection } from "./models";
import { ThemeSection } from "./theme";

interface Props {
  snippets: Snippet[];
  models: ModelsState;
  onModels: (models: ModelsState) => void;
  onSetup: () => void;
  commitMessage: string;
  onInsertSnippet: (snippet: Snippet) => void;
  keepScreenOn: boolean | null;
  onKeepScreenOn: (enabled: boolean) => void;
  lineWrapping: boolean;
  onLineWrapping: (enabled: boolean) => void;
}

export function Settings({
  snippets,
  models,
  onModels,
  onSetup,
  commitMessage,
  onInsertSnippet,
  keepScreenOn,
  onKeepScreenOn,
  lineWrapping,
  onLineWrapping,
}: Props) {
  const [sync, setSync] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

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
        <ModelsSection models={models} onModels={onModels} />
      </section>

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
          <p class="muted small">
            Add snippets to your config file, then say "snippet" and the name.
          </p>
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
        <ThemeSection />
        <label class="toggle">
          <input
            type="checkbox"
            checked={lineWrapping}
            onChange={(e) => onLineWrapping((e.target as HTMLInputElement).checked)}
          />
          Wrap long lines of code
        </label>
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
        <button type="button" class="pill" onClick={onSetup}>
          Run setup again
        </button>
        <Checks />
      </section>

      <p class="muted small">Workshop is unofficial and not affiliated with Advent of Code.</p>
    </div>
  );
}
