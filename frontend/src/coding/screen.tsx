import { useCallback, useEffect, useState } from "preact/hooks";
import { type Bootstrap, ConnectionError, TimeoutError } from "../api";
import { errorMessage } from "../errors";
import { useConnection } from "../hooks/useConnection";
import { TrackLessons } from "../learning/lesson";
import { ItemView, SyncChip, useLearning } from "../learning/practice";
import "../learning/practice.css";
import { newId, retirements } from "../learning/local";
import { RetiredList } from "../learning/retired";
import { getSnapshot, putSnapshot } from "../offline/db";
import { refreshCachedBundles, subscribeCachedBundles } from "../onDevice/bundles";
import { HomeButton, TrackTitle } from "../progress/page";
import type { TrackId } from "../tracks/types";
import "./coding.css";
import { codingApi } from "./api";
import {
  type BundleSyncSummary,
  type CachedCodingProblem,
  listCachedCodingProblems,
  offlineCapability,
  syncCodingBundle,
} from "./offline";
import { CodingLink, ProblemView } from "./problem";
import { STEP_LABELS, TASKS } from "./steps";
import type { Listed, Overview, Status } from "./types";

/** The Coding track: the list of its items, or one of them, as `pack/item`. */
export function CodingScreen({
  boot,
  item,
  onHome,
  onOpen,
  onOpenLesson,
  onTrack,
}: {
  boot: Bootstrap;
  item: string | null;
  onHome: () => void;
  /** Opens an item, or the list for null. */
  onOpen: (item: string | null) => void;
  /** Opens a lesson in the Coding track, by its key. */
  onOpenLesson: (item: string) => void;
  /** Goes to another track, such as the one a problem is in. */
  onTrack: (track: TrackId) => void;
}) {
  const learning = useLearning();
  const [, setBundleTick] = useState(0);
  useEffect(() => {
    void learning.sync();
    void refreshCachedBundles();
    return subscribeCachedBundles(() => setBundleTick((t) => t + 1));
  }, []);
  if (item === null)
    return <CodingList onHome={onHome} onOpen={onOpen} onOpenLesson={onOpenLesson} />;
  // Code to read is in the deck, so it works offline; problems need the server.
  const reading = learning.deck?.items.find((i) => i.key === item && i.kind === "reading");
  if (reading) {
    return (
      <div class="learn">
        <Header onHome={onHome} onList={() => onOpen(null)} />
        <main class="learn-content">
          <ItemView
            key={reading.key}
            item={reading}
            serverDictation={boot.server_dictation}
            onDone={() => onOpen(null)}
          />
        </main>
      </div>
    );
  }
  return (
    <ProblemView
      key={item}
      boot={boot}
      itemKey={item}
      onHome={onHome}
      onTrack={(track) => (track === "coding" ? onOpen(null) : onTrack(track))}
    />
  );
}

function Header({ onHome, onList }: { onHome: () => void; onList?: () => void }) {
  const learning = useLearning();
  return (
    <header class="top">
      <span class="header-start">
        <HomeButton onHome={onHome} />
        {onList ? <CodingLink onList={onList} /> : <TrackTitle title="Coding" icon="code" />}
      </span>
      <SyncChip status={learning.syncStatus} />
    </header>
  );
}

const STATUS: Record<Status, string> = {
  in_progress: "In progress",
  due: "Due",
  new: "New",
  done: "Done",
  flagged: "Flagged",
  retired: "Retired",
};

/** A track's problems and code to read, each to open. Cached problems also open offline. */
export function CodingItems({
  items,
  online,
  cached,
  onOpen,
}: {
  items: Listed[];
  online: boolean;
  /** Problems saved on this device for offline use, by key. */
  cached?: ReadonlyMap<string, CachedCodingProblem>;
  onOpen: (item: string) => void;
}) {
  return (
    <ul class="coding-list">
      {items.map((item) => {
        const cachedProblem = item.kind === "coding" ? cached?.get(item.key) : undefined;
        const canOpenOffline = item.kind === "reading" || cachedProblem !== undefined;
        const capabilityLabel =
          cachedProblem !== undefined
            ? offlineCapability(cachedProblem) === "runnable"
              ? " · runnable offline"
              : " · saved offline (edit & review)"
            : "";
        return (
          <li key={item.key}>
            <button
              type="button"
              class={`coding-item ${item.status}`}
              onClick={() => onOpen(item.key)}
              disabled={!online && !canOpenOffline}
            >
              <span class="coding-item-name">{item.label}</span>
              <span class="coding-item-detail muted">
                {kindOf(item)} · {statusOf(item)} · ~{item.minutes} min
                {!online ? capabilityLabel : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** What's in progress, then due, new, done and flagged, leaving out what's retired. */
export function toDo(items: Listed[]): Listed[] {
  const order: Status[] = ["in_progress", "due", "new", "done", "flagged"];
  return items
    .filter((item) => item.status !== "retired")
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
}

/** What sort of item it is, as the list says. */
function kindOf(item: Listed): string {
  if (item.task) return TASKS[item.task];
  return item.kind === "reading" ? "Code to read" : "Problem";
}

function statusOf(item: Listed): string {
  if (item.status !== "in_progress" || item.step === null) return STATUS[item.status];
  return `${item.mode === "recall" ? "Recalling" : "In progress"} · ${STEP_LABELS[item.step]}`;
}

/**
 * The track's problems and code to read, with what's in progress and due first. Offline, only
 * the code to read can be done, from the deck the device keeps.
 */
function CodingList({
  onHome,
  onOpen,
  onOpenLesson,
}: {
  onHome: () => void;
  onOpen: (item: string) => void;
  onOpenLesson: (item: string) => void;
}) {
  const online = useConnection();
  const learning = useLearning();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cachedProblems, setCachedProblems] = useState<Map<string, CachedCodingProblem>>(
    () => new Map(),
  );
  const [savingBundle, setSavingBundle] = useState(false);
  const [bundleSummary, setBundleSummary] = useState<BundleSyncSummary | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);

  const loadCached = useCallback(async () => {
    const list = await listCachedCodingProblems();
    const map = new Map<string, CachedCodingProblem>();
    for (const p of list) map.set(p.key, p);
    setCachedProblems(map);
    return map;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let fetchedFresh = false;
    let hasCachedOverview = false;
    const cachedReady = Promise.all([
      loadCached(),
      getSnapshot<Overview>("coding:overview").then((snap) => {
        if (!cancelled && snap && !fetchedFresh) {
          hasCachedOverview = true;
          setOverview(snap.value);
        }
      }),
    ]);
    // After what the device did reaches the server, such as code to read just retired.
    void learning
      .sync()
      .then(() => codingApi.overview())
      .then(
        (fresh) => {
          fetchedFresh = true;
          void putSnapshot("coding:overview", fresh);
          if (!cancelled) {
            setOverview(fresh);
            setError(null);
          }
        },
        async (e: unknown) => {
          const [loadedCached] = await cachedReady;
          if (cancelled) return;
          if (
            (e instanceof ConnectionError || e instanceof TimeoutError) &&
            hasCachedOverview &&
            loadedCached.size > 0
          ) {
            return;
          }
          setError(errorMessage(e));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [online, loadCached]);

  const saveForOffline = async () => {
    setSavingBundle(true);
    setBundleError(null);
    try {
      const summary = await syncCodingBundle();
      setBundleSummary(summary);
      await loadCached();
    } catch (e) {
      setBundleError(errorMessage(e));
    } finally {
      setSavingBundle(false);
    }
  };

  const items = overview ? toDo(overview.items) : null;
  const retired = overview ? overview.items.filter((item) => item.status === "retired") : [];
  const [bringing, setBringing] = useState<string | null>(null);
  const [bringError, setBringError] = useState<string | null>(null);
  const bringBack = (key: string) => {
    setBringing(key);
    setBringError(null);
    // Code to read is in the deck, so it's brought back as it was retired, from the device.
    let brought: Promise<unknown>;
    if (retired.some((item) => item.key === key && item.kind === "reading")) {
      learning.bringBack(key);
      brought = learning.sync();
    } else {
      brought = codingApi.bringBack(key, newId());
    }
    brought
      .then(() => codingApi.overview())
      .then(
        (fresh) => {
          void putSnapshot("coding:overview", fresh);
          setOverview(fresh);
        },
        (e: unknown) => setBringError(errorMessage(e)),
      )
      .finally(() => setBringing(null));
  };
  const deck = learning.deck;
  const standing = deck ? retirements(deck, learning.retirementChanges) : {};
  const offlineReading = (deck?.items ?? []).filter(
    (i) => i.kind === "reading" && i.track === "coding" && standing[i.key]?.state !== "retired",
  );
  const showCachedOffline = !online && cachedProblems.size > 0;

  return (
    <div class="learn">
      <Header onHome={onHome} />
      <main class="learn-content">
        {online ? (
          <div class="picker-status">
            <span class="muted small">
              {cachedProblems.size > 0
                ? `${cachedProblems.size} problems saved offline${bundleSummary?.oraclesComputing ? " · preparing random tests…" : ""}`
                : "Not saved for offline yet"}
            </span>
            <button
              type="button"
              class="text-button"
              disabled={savingBundle}
              onClick={() => void saveForOffline()}
            >
              {savingBundle
                ? "Saving for offline…"
                : cachedProblems.size > 0
                  ? "Refresh offline copy"
                  : "Save problems for offline"}
            </button>
          </div>
        ) : null}
        {bundleError ? <p class="error-text small">{bundleError}</p> : null}
        {items && (online || showCachedOffline) ? (
          <>
            {showCachedOffline ? (
              <p class="banner offline" role="status">
                Offline. Saved coding problems open for editing and review; running code needs the
                server.
              </p>
            ) : null}
            <CodingItems items={items} online={online} cached={cachedProblems} onOpen={onOpen} />
          </>
        ) : null}
        {items && online ? (
          <RetiredList
            items={retired}
            bringing={bringing}
            disabled={!online}
            error={bringError}
            onBringBack={bringBack}
          />
        ) : !showCachedOffline && error ? (
          <>
            <p class="banner offline" role="status">
              Coding problems need the server, which can't be reached. Code to read works offline.
            </p>
            {offlineReading.length > 0 ? (
              <ul class="coding-list">
                {offlineReading.map((item) => (
                  <li key={item.key}>
                    <button type="button" class="coding-item" onClick={() => onOpen(item.key)}>
                      <span class="coding-item-name">{item.label}</span>
                      <span class="coding-item-detail muted">Code to read</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="muted">
                Nothing to read is kept on this device yet: open Workshop once while connected.
              </p>
            )}
          </>
        ) : !items ? (
          <p class="muted">Loading…</p>
        ) : null}
        {deck ? <TrackLessons deck={deck} track="coding" onOpen={onOpenLesson} /> : null}
      </main>
    </div>
  );
}
