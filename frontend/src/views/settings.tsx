import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, type ModelsState, type Snippet } from "../api";
import type { DictationMethod, DictationSupport } from "../dictation";
import { useCloseOnBack } from "../hooks/useCloseOnBack";
import type { Packages } from "../hooks/usePackages";
import { isUpToDate } from "../packages";
import type { DictationChoice } from "../preferences";
import { Checks } from "./checks";
import { Modal } from "./modal";
import { ModelsSection } from "./models";
import { PackagesSection } from "./packages";
import { ServerSpeechSection } from "./speech";
import { ThemeSection } from "./theme";

interface Props {
  onClose: () => void;
  snippets: Snippet[];
  models: ModelsState;
  onModels: (models: ModelsState) => void;
  onSetup: () => void;
  /** Opens the comparison of speech recognition on this device and the server. */
  onBench: () => void;
  commitMessage: string;
  /** Where solutions are saved, as shown to the user. */
  solutionsDir: string;
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

/** A page of settings, opened from the list. */
type Page = "models" | "talking" | "packages" | "display" | "repo" | "snippets" | "setup";

const TITLES: Record<Page, string> = {
  models: "Models",
  talking: "Talking",
  packages: "Packages",
  display: "Display",
  repo: "Solutions repo",
  snippets: "Snippets",
  setup: "Setup and checks",
};

const METHOD_NAMES: Record<DictationMethod, string> = {
  server: "Whisper on the server",
  browser: "This browser's speech recognition",
  keyboard: "Keyboard dictation",
};

const METHOD_DESCRIPTIONS: Record<DictationMethod, string> = {
  server:
    "Hold the button and speak; Whisper on the server hears you once you let go, which is the most accurate.",
  browser: "Hold the button and speak; this browser's speech recognition hears you as you go.",
  keyboard:
    "Tap the button, then use your keyboard's microphone, which is often more accurate than the browser's.",
};

/**
 * Settings, as a list of pages with what each is set to, so each page holds only what it's
 * about. Going back from a page returns to the list.
 */
export function Settings(props: Props) {
  const [page, setPage] = useState<Page | null>(null);
  const top = useRef<HTMLDivElement>(null);
  // Each page starts at its top, rather than wherever the last one was scrolled to.
  useLayoutEffect(() => {
    const body = top.current?.closest(".sheet-body");
    if (body) body.scrollTop = 0;
  }, [page]);

  const back = () => setPage(null);
  return (
    <Modal
      title={page ? TITLES[page] : "Settings"}
      onClose={props.onClose}
      onBack={page ? back : undefined}
      shape="full"
    >
      <div ref={top} class="settings">
        {page === null ? (
          <SettingsList {...props} onOpen={setPage} />
        ) : (
          <SettingsPage key={page} onBack={back}>
            <PageContent page={page} {...props} />
          </SettingsPage>
        )}
      </div>
    </Modal>
  );
}

/** A page, which going back leaves for the list. */
function SettingsPage({ onBack, children }: { onBack: () => void; children: ComponentChildren }) {
  useCloseOnBack(onBack);
  return <>{children}</>;
}

function SettingsList(props: Props & { onOpen: (page: Page) => void }) {
  const { models, dictation, packages, snippets } = props;
  const edit = models.settings.edit;
  const provider = models.providers.find((p) => p.id === edit.provider);
  const packagesState = packages.state;

  const rows: [Page, string][] = [
    ["models", `${provider?.name ?? edit.provider}, ${edit.model} for edits`],
    [
      "talking",
      `${METHOD_NAMES[dictation.method]}${dictation.choice === "auto" ? ", chosen automatically" : ""}`,
    ],
    ...(packagesState
      ? [
          [
            "packages",
            packagesState.packages.length === 0
              ? "None listed"
              : `${packagesState.packages.length} listed${isUpToDate(packagesState) ? "" : ", not all installed"}`,
          ] satisfies [Page, string],
        ]
      : []),
    [
      "display",
      [
        "Colours",
        props.lineWrapping ? "long lines wrap" : "long lines scroll",
        props.keepScreenOn ? "screen stays on" : null,
      ]
        .filter((part) => part !== null)
        .join(", "),
    ],
    [
      "repo",
      props.commitAfterStar ? "Commits and pushes after each star" : "Commit and push by hand",
    ],
    ["snippets", snippets.length === 0 ? "None yet" : `${snippets.length} to insert`],
    ["setup", "Run setup again, and check everything is working"],
  ];

  return (
    <>
      <ul class="settings-list">
        {rows.map(([page, summary]) => (
          <li key={page} class="settings-row">
            <button type="button" onClick={() => props.onOpen(page)}>
              <span class="settings-row-text">
                <span class="settings-row-title">{TITLES[page]}</span>
                <span class="settings-row-summary">{summary}</span>
              </span>
              <span class="settings-row-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p class="muted small">Workshop is unofficial and not affiliated with Advent of Code.</p>
    </>
  );
}

function PageContent({ page, ...props }: Props & { page: Page }) {
  switch (page) {
    case "models":
      return <ModelsSection models={props.models} onModels={props.onModels} heading={false} />;
    case "talking":
      return <TalkingPage {...props} />;
    case "packages":
      return <PackagesSection packages={props.packages} heading={false} />;
    case "display":
      return <DisplayPage {...props} />;
    case "repo":
      return <RepoPage {...props} />;
    case "snippets":
      return <SnippetsPage {...props} />;
    case "setup":
      return <SetupPage {...props} />;
  }
}

function TalkingPage({ dictation, onDictation, onServerSpeech, onBench }: Props) {
  return (
    <>
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
        {dictation.support.browser ? "" : "This browser has no speech recognition of its own."} Kept
        on this device only.
      </p>
      <ServerSpeechSection onReady={onServerSpeech} />
      <p class="small">
        <button type="button" class="text-button" onClick={onBench}>
          Compare speech recognition on this device
        </button>
      </p>
    </>
  );
}

function DisplayPage({ lineWrapping, onLineWrapping, keepScreenOn, onKeepScreenOn }: Props) {
  return (
    <>
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
    </>
  );
}

function RepoPage({ commitMessage, solutionsDir, commitAfterStar, onCommitAfterStar }: Props) {
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
    <>
      <p class="small">
        Your solutions are in <code>{solutionsDir}</code> on the server.
      </p>
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
    </>
  );
}

function SnippetsPage({ snippets, onInsertSnippet }: Props) {
  if (snippets.length === 0) {
    return (
      <p class="muted small">Add snippets to your config file, then say "snippet" and the name.</p>
    );
  }
  return (
    <>
      <p class="muted small">Tap one to insert it at the cursor, or say "snippet" and its name.</p>
      <div class="snippets wrap">
        {snippets.map((s) => (
          <button type="button" key={s.name} class="chip" onClick={() => onInsertSnippet(s)}>
            {s.name}
          </button>
        ))}
      </div>
    </>
  );
}

function SetupPage({ onSetup }: Props) {
  return (
    <>
      <button type="button" class="pill" onClick={onSetup}>
        Run setup again
      </button>
      <h2 class="settings-subheading">Checks</h2>
      <Checks />
    </>
  );
}
