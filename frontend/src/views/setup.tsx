import { useEffect, useState } from "preact/hooks";
import { api, type ModelsState, type SetupState } from "../api";
import type { Packages } from "../hooks/usePackages";
import { isUpToDate } from "../packages";
import { Checks } from "./checks";
import { InstallProgress, LastInstallLog } from "./install";
import { ModelsSection } from "./models";
import { PackagesSection } from "./packages";
import { ServerSpeechSection } from "./speech";

interface Props {
  models: ModelsState;
  onModels: (models: ModelsState) => void;
  packages: Packages;
  /** Opens the practice puzzle, to try Workshop out. */
  onPractice: () => void;
  /** Called once a session cookie has been saved. */
  onLoggedIn: () => void;
  /** Called with whether Whisper on the server is ready, as that's found out. */
  onServerSpeech: (ready: boolean) => void;
  onDone: () => void;
}

/** How often to check on an install, for its progress. */
const INSTALL_PROGRESS_MS = 1000;

/** Getting Workshop ready: language, model, Advent of Code login and phone access. */
export function Setup({
  models,
  onModels,
  packages,
  onPractice,
  onLoggedIn,
  onServerSpeech,
  onDone,
}: Props) {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api
      .setup()
      .then(setState)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  if (state === null) {
    return error ? <p class="error-text">{error}</p> : <p class="muted">Checking your setup…</p>;
  }

  return (
    <div class="setup">
      <p>A few things to set up before you start. Each step can be changed later in Settings.</p>
      {numbered([
        (n) => (
          <LanguageStep key="language" n={n} state={state} onState={setState} onRefresh={load} />
        ),
        (n) => <ModelStep key="model" n={n} state={state} models={models} onModels={onModels} />,
        packages.state ? (n) => <PackagesStep key="packages" n={n} packages={packages} /> : null,
        (n) => <SpeechStep key="speech" n={n} onServerSpeech={onServerSpeech} />,
        (n) => (
          <LoginStep
            key="login"
            n={n}
            hasSession={state.has_aoc_session}
            onSaved={() => {
              onLoggedIn();
              load();
            }}
          />
        ),
        (n) => <PhoneStep key="phone" n={n} state={state} onRefresh={load} />,
        (n) => (
          <section key="checks">
            <h2>{n}. Check everything</h2>
            <Checks />
          </section>
        ),
      ])}
      <button type="button" class="pill primary wide" onClick={onDone}>
        Done
      </button>
      <p class="muted small center">
        New to Workshop?{" "}
        <button type="button" class="text-button" onClick={onPractice}>
          Try the practice puzzle
        </button>
        , which needs no Advent of Code login.
      </p>
    </div>
  );
}

/** Renders the steps that apply, numbering them in order. */
function numbered(steps: (((n: number) => preact.JSX.Element) | null)[]) {
  return steps.filter((s) => s !== null).map((step, i) => step(i + 1));
}

function Step({
  title,
  done,
  children,
}: {
  title: string;
  done: boolean;
  children: preact.ComponentChildren;
}) {
  return (
    <section>
      <h2>
        {title} <span class={done ? "ok-mark" : "todo-mark"}>{done ? "✓" : "·"}</span>
      </h2>
      {children}
    </section>
  );
}

function LanguageStep({
  n,
  state,
  onState,
  onRefresh,
}: {
  n: number;
  state: SetupState;
  onState: (state: SetupState) => void;
  onRefresh: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installingSince, setInstallingSince] = useState<number | null>(null);
  const current = state.languages.find((l) => l.id === state.language);
  const installing = installingSince !== null || state.toolchain_install.installing;

  // Follows an install's progress, including one started elsewhere, such as in another tab.
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(onRefresh, INSTALL_PROGRESS_MS);
    return () => clearInterval(timer);
  }, [installing]);

  const install = async () => {
    setInstallingSince(performance.now());
    setError(null);
    try {
      onState(await api.installToolchain());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onRefresh();
    } finally {
      setInstallingSince(null);
    }
  };

  const choose = async (id: string) => {
    setSaving(true);
    try {
      await api.setLanguage(id);
      // The editor, syntax highlighting and language server all depend on the language.
      location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Step title={`${n}. Language`} done={current !== undefined && current.missing.length === 0}>
      <div class="snippets">
        {state.languages.map((l) => (
          <button
            type="button"
            key={l.id}
            class={`chip ${l.id === state.language ? "selected" : ""}`}
            disabled={saving}
            onClick={() => l.id !== state.language && void choose(l.id)}
          >
            {l.name}
          </button>
        ))}
      </div>
      {current && current.missing.length > 0 && !installing ? (
        <p class="error-text">
          {current.name} needs {current.missing.join(" and ")}, which isn't installed.
        </p>
      ) : null}
      {current?.installable && (installing || current.missing.length > 0) ? (
        installing ? (
          <InstallProgress
            label={`Installing ${current.name}…`}
            since={installingSince}
            progress={state.toolchain_install.progress}
            onCancel={() => {
              api.cancelToolchainInstall().catch(() => {});
            }}
          />
        ) : state.mise_installed ? (
          <>
            <button type="button" class="pill primary" onClick={() => void install()}>
              Install with mise
            </button>
            <p class="muted small">
              Installs {current.name} and its language server for your solutions folder only,
              without changing anything else on the server. It can take several minutes.
            </p>
          </>
        ) : (
          <p class="muted small">
            Install it yourself, or install{" "}
            <a href="https://mise.jdx.dev/getting-started.html" target="_blank" rel="noreferrer">
              mise
            </a>{" "}
            on the server and Workshop can install it for your solutions folder only.{" "}
            <button type="button" class="text-button" onClick={onRefresh}>
              Check again
            </button>
          </p>
        )
      ) : null}
      {state.toolchain_problem ? <p class="error-text small">{state.toolchain_problem}</p> : null}
      {state.toolchain_install.last_install && !installing ? (
        <LastInstallLog last={state.toolchain_install.last_install} />
      ) : null}
      {current?.missing_language_server ? (
        <p class="muted small">
          Optional: install {current.missing_language_server} for error underlines and types.
        </p>
      ) : null}
      {error ? <p class="error-text">{error}</p> : null}
    </Step>
  );
}

function SpeechStep({
  n,
  onServerSpeech,
}: {
  n: number;
  onServerSpeech: (ready: boolean) => void;
}) {
  const [ready, setReady] = useState(false);
  return (
    <Step title={`${n}. Speech`} done={ready}>
      <ServerSpeechSection
        onReady={(next) => {
          setReady(next);
          onServerSpeech(next);
        }}
      />
      {ready ? null : (
        <p class="muted small">
          Optional: without it, Workshop uses your browser's own speech recognition, or your
          keyboard's dictation, which you can choose in Settings, under Talking.
        </p>
      )}
    </Step>
  );
}

function ModelStep({
  n,
  state,
  models,
  onModels,
}: {
  n: number;
  state: SetupState;
  models: ModelsState;
  onModels: (models: ModelsState) => void;
}) {
  const chosen = state.providers.find((p) => p.id === models.settings.edit.provider);
  return (
    <Step title={`${n}. Model`} done={chosen?.installed === true && chosen.logged_in !== false}>
      <ul class="checks">
        {state.providers.map((p) => (
          <li key={p.id} class={`check ${p.installed && p.logged_in !== false ? "ok" : "warn"}`}>
            <span class="mark">{p.installed && p.logged_in !== false ? "✓" : "!"}</span>
            <div>
              {p.name}:{" "}
              <span class="muted">
                {!p.installed
                  ? "not installed"
                  : p.logged_in === false
                    ? "installed, but not logged in"
                    : "ready"}
              </span>
              {!p.installed && p.install_hint ? <div class="fix">{p.install_hint}</div> : null}
            </div>
          </li>
        ))}
      </ul>
      <ModelsSection models={models} onModels={onModels} heading={false} />
    </Step>
  );
}

function LoginStep({
  n,
  hasSession,
  onSaved,
}: {
  n: number;
  hasSession: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(!hasSession);
  const [cookie, setCookie] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.setAocSession(cookie);
      setCookie("");
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Step title={`${n}. Advent of Code login`} done={hasSession && !editing}>
      {!editing ? (
        <p class="muted">
          Logged in.{" "}
          <button type="button" class="text-button" onClick={() => setEditing(true)}>
            Use a different cookie
          </button>
        </p>
      ) : (
        <>
          <p class="small">
            Workshop fetches puzzles as you, using your session cookie. In a desktop browser, log in
            at adventofcode.com, open the developer tools (Application in Chrome, Storage in Firefox
            and Safari), and under Cookies copy the value of the one called
            <code> session</code>. It's saved on the server only.
          </p>
          <form class="cookie-form" onSubmit={save}>
            <input
              type="password"
              value={cookie}
              onInput={(e) => setCookie((e.target as HTMLInputElement).value)}
              placeholder="Paste the session cookie"
              autocomplete="off"
              spellcheck={false}
            />
            <button type="submit" class="pill" disabled={saving || cookie.trim() === ""}>
              {saving ? "Checking…" : "Save"}
            </button>
          </form>
        </>
      )}
      {error ? <p class="error-text">{error}</p> : null}
    </Step>
  );
}

function PackagesStep({ n, packages }: { n: number; packages: Packages }) {
  return (
    <Step title={`${n}. Packages`} done={packages.state !== null && isUpToDate(packages.state)}>
      <PackagesSection packages={packages} heading={false} />
    </Step>
  );
}

function PhoneStep({
  n,
  state,
  onRefresh,
}: {
  n: number;
  state: SetupState;
  onRefresh: () => void;
}) {
  return (
    <Step title={`${n}. Your phone`} done={state.phone_url !== null}>
      {state.phone_url !== null ? (
        <>
          <p class="small">Scan this with your phone's camera, or open the link on it:</p>
          {state.phone_qr_svg ? (
            // Generated by Workshop's server from the link above.
            <div class="qr" dangerouslySetInnerHTML={{ __html: state.phone_qr_svg }} />
          ) : null}
          <p class="phone-link">
            <code>{state.phone_url}</code>
          </p>
        </>
      ) : (
        <>
          <p class="small">
            Browsers only allow the microphone over HTTPS, so your phone needs a secure way to reach
            the server.{" "}
            {state.tailscale_installed
              ? "Tailscale is installed: restart Workshop with `workshop serve --tailscale`, and a link and QR code for your phone will appear here."
              : "The easiest is Tailscale (tailscale.com): install it on the server and your phone, then start Workshop with `workshop serve --tailscale`."}
          </p>
          <button type="button" class="text-button" onClick={onRefresh}>
            Check again
          </button>
        </>
      )}
    </Step>
  );
}
