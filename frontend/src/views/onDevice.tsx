import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { useConnectionStatus } from "../hooks/useConnection";
import { useLearning } from "../learning/practice";
import {
  type CachedAocPuzzle,
  type CachedHelpers,
  clearStore,
  listAocPuzzles,
  listRecords,
  requestPersistentStorage,
  type StorageDiagnostics,
  storageDiagnostics,
} from "../offline/db";
import { type OutboxIssue, outbox } from "../offline/outbox";
import {
  BUNDLE_CATALOG,
  type BundleSpec,
  bundleForLanguage,
  bundleTotalBytes,
  type DeviceDownloadProgress,
  installBundleToDevice,
  isBundleCachedSync,
  onDeviceApi,
  refreshCachedBundles,
  removeBundleFromDevice,
  type ServerOnDeviceBundlesState,
  subscribeCachedBundles,
} from "../onDevice/bundles";
import { localRunner, resolveRunBackend } from "../onDevice/runner";
import { ON_DEVICE_MODES, type OnDeviceMode } from "../preferences";

const MODE_LABELS: Record<OnDeviceMode, string> = {
  server: "Server",
  automatic: "Automatic",
  local: "On device",
};

const MODE_DESCRIPTIONS: Record<OnDeviceMode, string> = {
  server:
    "Always use the server for checks, formatting and running code. Cached puzzles and tracks still open offline.",
  automatic:
    "Prefer the server when reachable, and switch to on-device checks and running when disconnected (once a local toolchain bundle is installed).",
  local:
    "Prefer on-device checks and running whenever a local toolchain bundle is installed for this language.",
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface OnDeviceProps {
  mode: OnDeviceMode;
  onMode: (mode: OnDeviceMode) => void;
  languageId: string;
  languageName: string;
  hasLsp: boolean;
  lspBackend?: "server" | "local" | undefined;
  hasFormatter: boolean;
}

/**
 * Diagnostics and controls for offline and on-device operation: connection status, which backend
 * handles checks/runs, persistent storage, cached puzzles/problems, on-device runtime bundles, and
 * pending syncs.
 */
export function OnDevicePage({
  mode,
  onMode,
  languageId,
  languageName,
  hasLsp,
  lspBackend,
  hasFormatter,
}: OnDeviceProps) {
  const conn = useConnectionStatus();
  const learning = useLearning();
  const [outboxCount, setOutboxCount] = useState(() => outbox().pending);
  const [issues, setIssues] = useState<readonly OutboxIssue[]>(() => outbox().issues());
  const [storage, setStorage] = useState<StorageDiagnostics | null>(null);
  const [puzzles, setPuzzles] = useState<CachedAocPuzzle[]>([]);
  const [codingCount, setCodingCount] = useState(0);
  const [helpers, setHelpers] = useState<CachedHelpers[]>([]);
  const [showPuzzles, setShowPuzzles] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [serverBundles, setServerBundles] = useState<ServerOnDeviceBundlesState | null>(null);
  const [cachedTick, setCachedTick] = useState(0);
  const [deviceDownload, setDeviceDownload] = useState<{
    bundleId: string;
    progress: DeviceDownloadProgress | null;
  } | null>(null);
  const deviceAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const [diag, aoc, coding, cachedHelpers] = await Promise.all([
      storageDiagnostics(),
      listAocPuzzles(),
      listRecords("codingBundle"),
      listRecords<CachedHelpers>("helpers"),
      refreshCachedBundles(),
    ]);
    setStorage(diag);
    setPuzzles(aoc.sort((a, b) => (a.year !== b.year ? b.year - a.year : a.day - b.day)));
    setCodingCount(coding.length);
    setHelpers(cachedHelpers);
    setCachedTick((t) => t + 1);
    if (conn.online) {
      onDeviceApi
        .bundles()
        .then(setServerBundles)
        .catch(() => {});
    }
  }, [conn.online]);

  useEffect(() => {
    void refresh();
    const unsubOutbox = outbox().subscribe(() => {
      setOutboxCount(outbox().pending);
      setIssues(outbox().issues());
    });
    const unsubBundles = subscribeCachedBundles(() => setCachedTick((t) => t + 1));
    return () => {
      unsubOutbox();
      unsubBundles();
    };
  }, [refresh]);

  useEffect(() => {
    if (!serverBundles?.download.installing) return;
    const timer = setInterval(() => {
      onDeviceApi
        .bundles()
        .then(setServerBundles)
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [serverBundles?.download.installing]);

  const downloadToServer = async (bundle: BundleSpec) => {
    setMessage(null);
    setServerBundles((prev) =>
      prev
        ? {
            ...prev,
            download: { ...prev.download, installing: true, progress: "Starting download…" },
          }
        : prev,
    );
    try {
      const next = await onDeviceApi.downloadOnServer(bundle.id);
      setServerBundles(next);
      setMessage(
        `${bundle.engine} is ready on the server. Tap "Install on this device" to cache it locally.`,
      );
    } catch (e) {
      setMessage(`Server download failed: ${errorMessage(e)}`);
      onDeviceApi
        .bundles()
        .then(setServerBundles)
        .catch(() => {});
    }
  };

  const cancelServerDownload = async () => {
    try {
      const next = await onDeviceApi.cancelServerDownload();
      setServerBundles(next);
    } catch (e) {
      setMessage(`Couldn't cancel download: ${errorMessage(e)}`);
    }
  };

  const installToDevice = async (bundle: BundleSpec) => {
    setMessage(null);
    const controller = new AbortController();
    deviceAbort.current = controller;
    setDeviceDownload({ bundleId: bundle.id, progress: null });
    try {
      await installBundleToDevice(
        bundle,
        (progress) => setDeviceDownload({ bundleId: bundle.id, progress }),
        controller.signal,
      );
      await refresh();
      if (mode === "server") {
        onMode("automatic");
        setMessage(
          `${bundle.engine} installed and SHA-256 verified. Switched on-device mode to Automatic so it activates when offline.`,
        );
      } else {
        setMessage(`${bundle.engine} installed and SHA-256 verified on this device.`);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setMessage(`Device install failed: ${errorMessage(e)}`);
      } else {
        setMessage("Device install cancelled.");
      }
    } finally {
      if (deviceAbort.current === controller) deviceAbort.current = null;
      setDeviceDownload(null);
    }
  };

  const removeFromDevice = async (bundle: BundleSpec) => {
    setMessage(null);
    localRunner().dispose();
    await removeBundleFromDevice(bundle.id);
    await refresh();
    setMessage(`Removed ${bundle.engine} from this device.`);
  };

  const removeFromServer = async (bundle: BundleSpec) => {
    setMessage(null);
    try {
      const next = await onDeviceApi.deleteOnServer(bundle.id);
      setServerBundles(next);
      setMessage(`Removed ${bundle.engine} from the server cache.`);
    } catch (e) {
      setMessage(`Couldn't remove bundle from server: ${errorMessage(e)}`);
    }
  };

  const totalPending = learning.syncStatus.pending + outboxCount;

  const syncNow = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      await Promise.all([learning.sync(), outbox().flush()]);
      setOutboxCount(outbox().pending);
      setMessage(
        outbox().pending + learning.syncStatus.pending === 0 ? "Everything synced." : null,
      );
    } catch (e) {
      setMessage(`Sync didn't finish: ${errorMessage(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  const askPersist = async () => {
    setMessage(null);
    const granted = await requestPersistentStorage();
    await refresh();
    setMessage(
      granted
        ? "This browser will keep Workshop's offline data across storage clean-ups."
        : "The browser didn't grant persistent storage (installing Workshop to the home screen usually enables it).",
    );
  };

  const clearCache = async () => {
    setMessage(null);
    await Promise.all([
      clearStore("snapshots"),
      clearStore("aoc"),
      clearStore("aocYear"),
      clearStore("helpers"),
      clearStore("codingBundle"),
      clearStore("codingTests"),
    ]);
    await refresh();
    setMessage("Cleared cached puzzles and snapshots. Unsaved edits and pending syncs were kept.");
  };

  const connectionLabel = !conn.online
    ? "Offline"
    : conn.slow
      ? "Slow connection"
      : conn.lastRttMs !== null
        ? `Online (${conn.lastRttMs} ms)`
        : "Online";

  // Reference cachedTick so the active runner label re-computes when bundles install or are removed.
  const activeBundle = cachedTick >= 0 ? bundleForLanguage(languageId) : null;
  const activeBundleCached = activeBundle !== null && isBundleCachedSync(activeBundle.id);
  const runnerBackend = resolveRunBackend(mode, conn.online, activeBundleCached);
  const runnerLabel =
    runnerBackend === "local" && activeBundle ? `On device (${activeBundle.engine})` : "On server";

  return (
    <div class="on-device">
      <div class="snippets wrap">
        {ON_DEVICE_MODES.map((choice) => (
          <button
            type="button"
            key={choice}
            class={`chip ${mode === choice ? "selected" : ""}`}
            onClick={() => onMode(choice)}
          >
            {MODE_LABELS[choice]}
          </button>
        ))}
      </div>
      <p class="muted small">{MODE_DESCRIPTIONS[mode]} Kept on this device only.</p>

      <h3 class="settings-heading">Live backends ({languageName})</h3>
      <dl class="on-device-dl">
        <dt>Connection</dt>
        <dd>{connectionLabel}</dd>
        <dt>Language server</dt>
        <dd>
          {!hasLsp
            ? "None for this language"
            : lspBackend === "local" && activeBundle
              ? `On device (${activeBundle.engine})`
              : "On server"}
        </dd>
        <dt>Runner</dt>
        <dd>{runnerLabel}</dd>
        <dt>Formatter</dt>
        <dd>{hasFormatter ? "On server" : hasLsp ? "Language server" : "None"}</dd>
      </dl>

      <h3 class="settings-heading">On-device runtimes</h3>
      <ul class="on-device-list">
        {BUNDLE_CATALOG.map((bundle) => {
          const serverInfo = serverBundles?.bundles.find((b) => b.id === bundle.id) ?? null;
          const onServer = serverInfo?.installed_on_server ?? false;
          const onDevice = isBundleCachedSync(bundle.id);
          const serverBusy = serverBundles?.download.installing ?? false;
          const deviceBusy = deviceDownload?.bundleId === bundle.id;
          const progress = deviceBusy ? deviceDownload.progress : null;
          return (
            <li key={bundle.id} class="on-device-bundle">
              <div class="on-device-list-row">
                <span>
                  <strong>{bundle.engine}</strong> ({bundle.language})
                </span>
                <span class="muted small">
                  {bundle.version} · {formatBytes(bundleTotalBytes(bundle))}
                </span>
              </div>
              <p class="muted small">
                {onDevice
                  ? "Installed & SHA-256 verified on this device."
                  : onServer
                    ? "Ready on server; install on this device to run offline."
                    : "Not downloaded yet."}
              </p>
              {serverBusy && serverBundles?.download.progress ? (
                <p class="muted small" role="status">
                  Server: {serverBundles.download.progress}
                </p>
              ) : null}
              {progress ? (
                <p class="muted small" role="status">
                  {progress.stage === "downloading"
                    ? `Downloading ${progress.file}: ${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`
                    : progress.stage === "verifying"
                      ? `Verifying SHA-256 for ${progress.file}…`
                      : `Saving ${progress.file} to device cache…`}
                </p>
              ) : null}
              <div class="on-device-actions">
                {!onServer ? (
                  serverBusy ? (
                    <button type="button" class="pill" onClick={() => void cancelServerDownload()}>
                      Cancel download
                    </button>
                  ) : (
                    <button
                      type="button"
                      class="pill"
                      disabled={!conn.online || deviceBusy}
                      onClick={() => void downloadToServer(bundle)}
                    >
                      Download to server
                    </button>
                  )
                ) : null}
                {onServer && !onDevice ? (
                  deviceBusy ? (
                    <button type="button" class="pill" onClick={() => deviceAbort.current?.abort()}>
                      Cancel install
                    </button>
                  ) : (
                    <button
                      type="button"
                      class="pill primary"
                      disabled={!conn.online || serverBusy}
                      onClick={() => void installToDevice(bundle)}
                    >
                      Install on this device
                    </button>
                  )
                ) : null}
                {onDevice ? (
                  <button
                    type="button"
                    class="text-button"
                    onClick={() => void removeFromDevice(bundle)}
                  >
                    Remove from device
                  </button>
                ) : null}
                {onServer && conn.online ? (
                  <button
                    type="button"
                    class="text-button"
                    disabled={serverBusy || deviceBusy}
                    onClick={() => void removeFromServer(bundle)}
                  >
                    Remove from server
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <h3 class="settings-heading">Offline storage</h3>
      <dl class="on-device-dl">
        <dt>Storage</dt>
        <dd>
          {storage === null
            ? "Checking…"
            : !storage.available
              ? "Unavailable in this browser"
              : `${formatBytes(storage.usageBytes)}${storage.quotaBytes !== null ? ` of ${formatBytes(storage.quotaBytes)}` : ""}`}
        </dd>
        <dt>Eviction protection</dt>
        <dd>
          {storage?.persisted === true
            ? "Persistent"
            : storage?.persisted === false
              ? "Not persistent"
              : "Unknown"}
        </dd>
        <dt>Advent of Code</dt>
        <dd>
          {puzzles.length} {puzzles.length === 1 ? "puzzle" : "puzzles"} cached
          {helpers.length > 0 ? ` · ${helpers.map((h) => h.file).join(", ")}` : ""}
        </dd>
        <dt>Coding track</dt>
        <dd>
          {codingCount} {codingCount === 1 ? "problem" : "problems"} cached
        </dd>
        <dt>Waiting to sync</dt>
        <dd>{totalPending === 0 ? "Nothing waiting" : `${totalPending} pending`}</dd>
      </dl>

      <div class="on-device-actions">
        {storage?.persisted === false ? (
          <button type="button" class="pill" onClick={() => void askPersist()}>
            Keep storage persistent
          </button>
        ) : null}
        <button
          type="button"
          class="pill"
          disabled={syncing || !conn.online}
          onClick={() => void syncNow()}
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
        {puzzles.length > 0 || codingCount > 0 ? (
          <button type="button" class="text-button" onClick={() => void clearCache()}>
            Clear offline cache
          </button>
        ) : null}
      </div>

      {puzzles.length > 0 ? (
        <div class="on-device-puzzles">
          <button
            type="button"
            class="text-button"
            onClick={() => setShowPuzzles((shown) => !shown)}
          >
            {showPuzzles ? "Hide cached puzzles" : `Show ${puzzles.length} cached puzzles`}
          </button>
          {showPuzzles ? (
            <ul class="on-device-list">
              {puzzles.map((p) => {
                const parts =
                  p.problemParts === 2
                    ? "Parts 1 & 2"
                    : p.problemParts === 1
                      ? "Part 1 only"
                      : "Code only";
                const label = p.year === 0 ? "Practice" : `${p.year} day ${p.day}`;
                return (
                  <li key={p.key} class="on-device-list-row">
                    <span>{label}</span>
                    <span class="muted small">
                      {parts}
                      {p.input !== undefined ? " · input" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {issues.length > 0 ? (
        <div class="on-device-puzzles">
          <h3 class="settings-heading">Sync issues needing attention</h3>
          <ul class="on-device-list">
            {issues.map((issue) => (
              <li key={issue.id} class="on-device-list-row">
                <span>
                  {issue.item}: {issue.message}
                </span>
                <button
                  type="button"
                  class="text-button"
                  onClick={() => outbox().dismissIssue(issue.id)}
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {message ? (
        <p class="muted small" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
