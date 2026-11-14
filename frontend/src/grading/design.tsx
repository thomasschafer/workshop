import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { newId } from "../learning/local";
import { Markdown } from "../learning/practice";
import { Loading, Page } from "../progress/page";
import { gradingApi } from "./api";
import { MarkedView } from "./marked";
import type { DesignListed, DesignOpened, MarkedReply } from "./types";

const STATUS = { due: "Due", new: "New", done: "Done" } as const;

/** Design prompts: the list of them, or one, as `pack/item`, answered in writing and marked by
 * the grader. */
export function DesignScreen({
  item,
  onHome,
  onOpen,
}: {
  item: string | null;
  onHome: () => void;
  onOpen: (item: string | null) => void;
}) {
  if (item === null) return <DesignList onHome={onHome} onOpen={onOpen} />;
  return <DesignItem key={item} itemKey={item} onHome={onHome} onList={() => onOpen(null)} />;
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
                  {STATUS[item.status]} · about {item.minutes} minutes
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

/** What's been written for a prompt, kept on the device until it's marked. */
const draftKey = (key: string) => `workshop:design:${key}`;

function DesignItem({
  itemKey,
  onHome,
  onList,
}: {
  itemKey: string;
  onHome: () => void;
  onList: () => void;
}) {
  const [opened, setOpened] = useState<DesignOpened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [text, setText] = useState(() => localStorage.getItem(draftKey(itemKey)) ?? "");
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [result, setResult] = useState<MarkedReply | null>(null);
  useEffect(() => {
    setError(null);
    gradingApi.design(itemKey).then(setOpened, (e: unknown) => setError(errorMessage(e)));
  }, [attempt]);

  const write = (next: string) => {
    setText(next);
    localStorage.setItem(draftKey(itemKey), next);
  };
  const mark = () => {
    setMarking(true);
    setMarkError(null);
    gradingApi
      .mark(itemKey, newId(), "design", text)
      .then(
        (reply) => {
          setResult(reply);
          localStorage.removeItem(draftKey(itemKey));
        },
        (e: unknown) => setMarkError(errorMessage(e)),
      )
      .finally(() => setMarking(false));
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
      <Markdown text={opened.prompt} class="learn-prompt" />
      {opened.source ? <p class="learn-source muted">Source: {opened.source}</p> : null}
      {result ? (
        <>
          <MarkedView marked={result.marked} />
          <button type="button" class="pill primary wide" onClick={onList}>
            Done
          </button>
        </>
      ) : (
        <form
          class="learn-form"
          onSubmit={(event) => {
            event.preventDefault();
            mark();
          }}
        >
          <label class="learn-question muted" for="design-answer">
            Your design, about {opened.minutes} minutes' worth
          </label>
          <textarea
            id="design-answer"
            class="written"
            value={text}
            readOnly={marking}
            onInput={(event) => write(event.currentTarget.value)}
          />
          {markError ? (
            <p class="error-text" role="alert">
              {markError}
            </p>
          ) : null}
          <span class="learn-actions">
            <button type="button" class="pill" onClick={onList}>
              Later
            </button>
            <button type="submit" class="pill primary" disabled={marking || !text.trim()}>
              {marking ? "Marking…" : "Mark it"}
            </button>
          </span>
          {opened.previous ? (
            <details>
              <summary class="muted">What you wrote last time</summary>
              <Markdown text={opened.previous} />
            </details>
          ) : null}
        </form>
      )}
    </Page>
  );
}
