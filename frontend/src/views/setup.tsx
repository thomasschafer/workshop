import { useEffect, useState } from "preact/hooks";
import { api, type ModelsState, type SetupState } from "../api";
import { Checks } from "./checks";
import { ModelsSection } from "./models";

interface Props {
  models: ModelsState;
  onModels: (models: ModelsState) => void;
  /** Called once a session cookie has been saved. */
  onLoggedIn: () => void;
  onDone: () => void;
}

/** Getting Workshop ready: language, model, Advent of Code login and phone access. */
export function Setup({ models, onModels, onLoggedIn, onDone }: Props) {
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
      <LanguageStep state={state} />
      <ModelStep state={state} models={models} onModels={onModels} />
      <LoginStep
        hasSession={state.has_aoc_session}
        onSaved={() => {
          onLoggedIn();
          load();
        }}
      />
      <PhoneStep state={state} onRefresh={load} />
      <section>
        <h2>5. Check everything</h2>
        <Checks />
      </section>
      <button type="button" class="pill primary wide" onClick={onDone}>
        Done
      </button>
    </div>
  );
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

function LanguageStep({ state }: { state: SetupState }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = state.languages.find((l) => l.id === state.language);

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
    <Step title="1. Language" done={current !== undefined && current.missing.length === 0}>
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
      {current && current.missing.length > 0 ? (
        <p class="error-text">
          {current.name} needs {current.missing.join(" and ")}, which isn't installed.
        </p>
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

function ModelStep({
  state,
  models,
  onModels,
}: {
  state: SetupState;
  models: ModelsState;
  onModels: (models: ModelsState) => void;
}) {
  const chosen = state.providers.find((p) => p.id === models.settings.edit.provider);
  return (
    <Step title="2. Model" done={chosen?.installed === true && chosen.logged_in !== false}>
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

function LoginStep({ hasSession, onSaved }: { hasSession: boolean; onSaved: () => void }) {
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
    <Step title="3. Advent of Code login" done={hasSession && !editing}>
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
            <code> session</code>. It's saved on this computer only.
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

function PhoneStep({ state, onRefresh }: { state: SetupState; onRefresh: () => void }) {
  return (
    <Step title="4. Your phone" done={state.phone_url !== null}>
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
            this computer.{" "}
            {state.tailscale_installed
              ? "Tailscale is installed: restart Workshop with `workshop serve --tailscale`, and a link and QR code for your phone will appear here."
              : "The easiest is Tailscale (tailscale.com): install it on this computer and your phone, then start Workshop with `workshop serve --tailscale`."}
          </p>
          <button type="button" class="text-button" onClick={onRefresh}>
            Check again
          </button>
        </>
      )}
    </Step>
  );
}
