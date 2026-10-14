import { useEffect, useState } from "preact/hooks";
import { api, type SpeechState } from "../api";
import { InstallProgress, LastInstallLog } from "./install";

/** How often to check on a download, for its progress. */
const PROGRESS_MS = 1000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Whisper on the server, which hears dictation more accurately than phones' own recognition:
 * whether it's ready, and downloading its model.
 */
export function ServerSpeechSection({ onReady }: { onReady: (ready: boolean) => void }) {
  const [state, setState] = useState<SpeechState | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = (next: SpeechState) => {
    setState(next);
    onReady(next.ready);
  };
  const refresh = () =>
    api
      .speech()
      .then(show)
      .catch((e: unknown) => setError(message(e)));
  useEffect(() => void refresh(), []);

  const downloading = since !== null || state?.download.installing === true;
  // Follows a download, including one started elsewhere, such as in another tab.
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void refresh(), PROGRESS_MS);
    return () => clearInterval(timer);
  }, [downloading]);

  const download = async () => {
    setSince(performance.now());
    setError(null);
    try {
      show(await api.downloadSpeechModel());
    } catch (e) {
      setError(message(e));
      await refresh();
    } finally {
      setSince(null);
    }
  };

  if (state === null) return error ? <p class="error-text small">{error}</p> : null;
  return (
    <div class="server-speech">
      {state.ready ? (
        <p class="small">Whisper is ready on the server.</p>
      ) : !state.whisper_installed ? (
        <p class="small">
          Whisper on the server hears code more accurately than most phones.{" "}
          <span class="muted">{state.install_hint}</span>{" "}
          <button type="button" class="text-button" onClick={() => void refresh()}>
            Check again
          </button>
        </p>
      ) : downloading ? (
        <InstallProgress
          label={`Downloading Whisper's ${state.model} model…`}
          since={since}
          progress={state.download.progress}
          onCancel={() => {
            api.cancelSpeechDownload().catch((e: unknown) => setError(message(e)));
          }}
        />
      ) : (
        <>
          <p class="small">
            Whisper on the server hears code more accurately than most phones. It needs its{" "}
            {state.model} model, {state.model_mb} MB.
          </p>
          <button type="button" class="pill" onClick={() => void download()}>
            Download it
          </button>
        </>
      )}
      {error ? <pre class="install-error">{error}</pre> : null}
      {state.download.last_install && !downloading && !state.ready ? (
        <LastInstallLog last={state.download.last_install} />
      ) : null}
    </div>
  );
}
