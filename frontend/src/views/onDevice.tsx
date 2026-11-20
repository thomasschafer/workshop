import { useCallback, useEffect, useState } from "preact/hooks";
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
import { outbox } from "../offline/outbox";
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
  languageName: string;
  hasLsp: boolean;
  hasFormatter: boolean;
}

/**
 * Diagnostics and controls for offline and on-device operation: connection status, which backend
 * handles checks/runs, persistent storage, cached puzzles/problems, and pending syncs.
 */
export function OnDevicePage({ mode, onMode, languageName, hasLsp, hasFormatter }: OnDeviceProps) {
  const conn = useConnectionStatus();
  const learning = useLearning();
  const [outboxCount, setOutboxCount] = useState(() => outbox().pending);
  const [storage, setStorage] = useState<StorageDiagnostics | null>(null);
  const [puzzles, setPuzzles] = useState<CachedAocPuzzle[]>([]);
  const [codingCount, setCodingCount] = useState(0);
  const [helpers, setHelpers] = useState<CachedHelpers[]>([]);
  const [showPuzzles, setShowPuzzles] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [diag, aoc, coding, cachedHelpers] = await Promise.all([
      storageDiagnostics(),
      listAocPuzzles(),
      listRecords("codingBundle"),
      listRecords<CachedHelpers>("helpers"),
    ]);
    setStorage(diag);
    setPuzzles(aoc.sort((a, b) => (a.year !== b.year ? b.year - a.year : a.day - b.day)));
    setCodingCount(coding.length);
    setHelpers(cachedHelpers);
  }, []);

  useEffect(() => {
    void refresh();
    return outbox().subscribe(() => setOutboxCount(outbox().pending));
  }, [refresh]);

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
        <dd>{hasLsp ? "On server" : "None for this language"}</dd>
        <dt>Runner</dt>
        <dd>On server</dd>
        <dt>Formatter</dt>
        <dd>{hasFormatter ? "On server" : hasLsp ? "Language server" : "None"}</dd>
      </dl>

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

      {message ? (
        <p class="muted small" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
