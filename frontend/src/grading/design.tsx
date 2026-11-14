import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { useConnection } from "../hooks/useConnection";
import { Markdown } from "../learning/practice";
import { Loading, Page } from "../progress/page";
import { gradingApi } from "./api";
import { DesignSessionView } from "./session";
import type { DesignListed, DesignOpened, Stage } from "./types";

const STATUS = { in_progress: "In progress", due: "Due", new: "New", done: "Done" } as const;

/** Design prompts: the list of them, or one, as `pack/item`, worked through as a session. */
export function DesignScreen({
  item,
  serverDictation,
  onHome,
  onOpen,
}: {
  item: string | null;
  serverDictation: boolean;
  onHome: () => void;
  onOpen: (item: string | null) => void;
}) {
  if (item === null) return <DesignList onHome={onHome} onOpen={onOpen} />;
  return (
    <DesignItem
      key={item}
      itemKey={item}
      serverDictation={serverDictation}
      onHome={onHome}
      onList={() => onOpen(null)}
    />
  );
}

function DesignList({ onHome, onOpen }: { onHome: () => void; onOpen: (item: string) => void }) {
  const [items, setItems] = useState<DesignListed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    gradingApi.designs().then(setItems, (e: unknown) => setError(errorMessage(e)));
  }, [attempt]);
  return (
    <Page title="System design" onHome={onHome}>
      {items === null ? (
        <Loading error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : items.length === 0 ? (
        <p class="muted">Your packs have no design prompts.</p>
      ) : (
        <ul class="design-list">
          {items.map((item) => (
            <li key={item.key}>
              <button type="button" class="home-link" onClick={() => onOpen(item.key)}>
                <span class="home-link-name">{item.label}</span>
                <span class="home-link-summary">
                  {STATUS[item.status]}
                  {item.stage ? `, at ${stageName(item.stage)}` : ""} · about {item.minutes} minutes
                  {item.last_score === null
                    ? ""
                    : ` · last time ${Math.round(item.last_score * 100)}%`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function stageName(stage: Stage): string {
  return stage.replace("_", " ").replace("trade offs", "trade-offs");
}

function DesignItem({
  itemKey,
  serverDictation,
  onHome,
  onList,
}: {
  itemKey: string;
  serverDictation: boolean;
  onHome: () => void;
  onList: () => void;
}) {
  const online = useConnection();
  const [opened, setOpened] = useState<DesignOpened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    setError(null);
    gradingApi.design(itemKey).then(setOpened, (e: unknown) => setError(errorMessage(e)));
  }, [attempt]);

  const start = () => {
    setStarting(true);
    setError(null);
    gradingApi
      .startDesign(itemKey)
      .then(setOpened, (e: unknown) => setError(errorMessage(e)))
      .finally(() => setStarting(false));
  };

  if (opened === null) {
    return (
      <Page title="System design" onHome={onHome}>
        <Loading error={error} onRetry={() => setAttempt((n) => n + 1)} />
      </Page>
    );
  }
  return (
    <Page title="System design" onHome={onHome}>
      {opened.session ? (
        <DesignSessionView
          opened={opened}
          session={opened.session}
          serverDictation={serverDictation}
          onDone={onList}
        />
      ) : (
        <>
          <Markdown text={opened.prompt} class="learn-prompt" />
          {opened.source ? <p class="learn-source muted">Source: {opened.source}</p> : null}
          <section class="design-intro" aria-label="Design session">
            <p class="muted">
              A design session of about {opened.minutes} minutes, in {opened.stages.length} stages:{" "}
              {opened.stages.map((s) => s.name.toLowerCase()).join(", ")}. A coach asks follow-up
              questions at each, and the whole session is marked at the end. Every stage is saved as
              you go, so you can stop at any of them and carry on later.
            </p>
            {error ? (
              <p class="error-text" role="alert">
                {error}
              </p>
            ) : null}
            <span class="learn-actions">
              <button type="button" class="pill" onClick={onList}>
                Later
              </button>
              <button
                type="button"
                class="pill primary"
                disabled={starting || !online}
                onClick={start}
              >
                Start the session
              </button>
            </span>
          </section>
          {opened.previous ? (
            <details>
              <summary class="muted">What you did last time</summary>
              <Markdown text={opened.previous} />
            </details>
          ) : null}
        </>
      )}
    </Page>
  );
}
