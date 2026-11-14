import { useEffect, useState } from "preact/hooks";
import type { Bootstrap } from "../api";
import { errorMessage } from "../errors";
import { useConnection } from "../hooks/useConnection";
import { ItemView, SyncChip, useLearning } from "../learning/practice";
import "../learning/practice.css";
import "./coding.css";
import { codingApi } from "./api";
import { ProblemView } from "./problem";
import { STEP_LABELS } from "./steps";
import type { Listed, Overview, Status } from "./types";

/** The Coding track: the list of its items, or one of them, as `pack/item`. */
export function CodingScreen({
  boot,
  item,
  onHome,
  onOpen,
}: {
  boot: Bootstrap;
  item: string | null;
  onHome: () => void;
  /** Opens an item, or the list for null. */
  onOpen: (item: string | null) => void;
}) {
  const learning = useLearning();
  useEffect(() => {
    void learning.sync();
  }, []);
  if (item === null) return <CodingList onHome={onHome} onOpen={onOpen} />;
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
      onList={() => onOpen(null)}
    />
  );
}

function Header({ onHome, onList }: { onHome: () => void; onList?: () => void }) {
  const learning = useLearning();
  return (
    <header class="top">
      <span class="header-start">
        <button type="button" class="icon-button home-button" aria-label="Home" onClick={onHome}>
          ⌂
        </button>
        {onList ? (
          <button type="button" class="text-button" onClick={onList}>
            Coding
          </button>
        ) : (
          <h1 class="app-title">Coding</h1>
        )}
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
};

function statusOf(item: Listed): string {
  if (item.status !== "in_progress" || item.step === null) return STATUS[item.status];
  return `${item.mode === "recall" ? "Recalling" : "In progress"} · ${STEP_LABELS[item.step]}`;
}

/**
 * The track's problems and code to read, with what's in progress and due first. Offline, only
 * the code to read can be done, from the deck the device keeps.
 */
function CodingList({ onHome, onOpen }: { onHome: () => void; onOpen: (item: string) => void }) {
  const online = useConnection();
  const learning = useLearning();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    codingApi.overview().then(setOverview, (e: unknown) => setError(errorMessage(e)));
  }, [online]);

  const order: Status[] = ["in_progress", "due", "new", "done", "flagged"];
  const items = overview
    ? [...overview.items].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
    : null;
  const offlineReading = (learning.deck?.items ?? []).filter(
    (i) => i.kind === "reading" && i.track === "coding",
  );

  return (
    <div class="learn">
      <Header onHome={onHome} />
      <main class="learn-content">
        {items ? (
          <ul class="coding-list">
            {items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  class={`coding-item ${item.status}`}
                  onClick={() => onOpen(item.key)}
                  disabled={item.kind === "coding" && !online}
                >
                  <span class="coding-item-name">{item.label}</span>
                  <span class="coding-item-detail muted">
                    {item.kind === "reading" ? "Code to read" : "Problem"} · {statusOf(item)} · ~
                    {item.minutes} min
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : error ? (
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
        ) : (
          <p class="muted">Loading…</p>
        )}
      </main>
    </div>
  );
}
