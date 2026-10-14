import { useState } from "preact/hooks";
import { api, type ModelsState, type Snippet } from "../api";
import type { DictationMethod, DictationSupport } from "../dictation";
import type { Packages } from "../hooks/usePackages";
import type { DictationChoice } from "../preferences";
import { Checks } from "./checks";
import { ModelsSection } from "./models";
import { PackagesSection } from "./packages";
import { ServerSpeechSection } from "./speech";
import { ThemeSection } from "./theme";

interface Props {
  snippets: Snippet[];
  models: ModelsState;
  onModels: (models: ModelsState) => void;
  onSetup: () => void;
  /** Opens the comparison of speech recognition on this device and the server. */
  onBench: () => void;
  commitMessage: string;
  commitAfterStar: boolean;
  onCommitAfterStar: (enabled: boolean) => void;
  onInsertSnippet: (snippet: Snippet) => void;
  keepScreenOn: boolean | null;
  onKeepScreenOn: (enabled: boolean) => void;
  packages: Packages;
  dictation: { choice: DictationChoice; method: DictationMethod; support: DictationSupport };
  onDictation: (choice: DictationChoice) => void;
  /** Called with whether Whisper on the server is ready, as that's found out. */
  onServerSpeech: (ready: boolean) => void;
  lineWrapping: boolean;
  onLineWrapping: (enabled: boolean) => void;
}

const METHOD_DESCRIPTIONS: Record<DictationMethod, string> = {
  server:
    "Hold the button and speak; Whisper on the server hears you once you let go, which is the most accurate.",
  browser: "Hold the button and speak; this browser's speech recognition hears you as you go.",
  keyboard:
    "Tap the button, then use your keyboard's microphone, which is often more accurate than the browser's.",
};

export function Settings({
  snippets,
  models,
  onModels,
  onSetup,
  onBench,
  commitMessage,
  commitAfterStar,
  onCommitAfterStar,
  onInsertSnippet,
  keepScreenOn,
  onKeepScreenOn,
  packages,
  dictation,
  onDictation,
  onServerSpeech,
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
        <h2>Talking</h2>
        <div class="snippets wrap">
          {(
            [
              ["auto", "Automatic"],
              ["server", "Whisper"],
              ["browser", "Browser"],
              ["keyboard", "Keyboard"],
            ] as const
          ).map(([choice, label]) => (
            <button
              type="button"
              key={choice}
              class={`chip ${dictation.choice === choice ? "selected" : ""}`}
              disabled={
                (choice === "server" && !dictation.support.server) ||
                (choice === "browser" && !dictation.support.browser)
              }
              onClick={() => onDictation(choice)}
            >
              {label}
            </button>
          ))}
        </div>
        <p class="muted small">
          {METHOD_DESCRIPTIONS[dictation.method]}{" "}
          {dictation.support.browser ? "" : "This browser has no speech recognition of its own."}{" "}
          Kept on this device only.
        </p>
        <ServerSpeechSection onReady={onServerSpeech} />
      </section>

      {packages.state ? (
        <section>
          <PackagesSection packages={packages} />
        </section>
      ) : null}

      <section>
        <h2>Solutions repo</h2>
        <button type="button" class="pill" onClick={commit} disabled={syncing}>
          {syncing ? "Committing…" : "Commit and push"}
        </button>
        {sync ? <p class="muted">{sync}</p> : null}
        <label class="toggle">
          <input
            type="checkbox"
            checked={commitAfterStar}
            onChange={(e) => onCommitAfterStar((e.target as HTMLInputElement).checked)}
          />
          Commit and push after each star
        </label>
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
        <button type="button" class="pill" onClick={onBench}>
          Compare speech recognition
        </button>
        <Checks />
      </section>

      <p class="muted small">Workshop is unofficial and not affiliated with Advent of Code.</p>
    </div>
  );
}
