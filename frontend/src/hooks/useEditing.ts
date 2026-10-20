import type { RefObject } from "preact";
import { useRef, useState } from "preact/hooks";
import { api, ConnectionError, connection, type Exchange, type Puzzle } from "../api";
import type { Anchor, CodeEditor } from "../editor";
import { errorMessage } from "../errors";
import {
  done,
  type Job,
  type JobContext,
  type Outcome,
  type UtteranceQueue,
  warn,
} from "../utterances";

/** How long an utterance waits for a puzzle's editor that's still loading. */
const EDITOR_WAIT_MS = 10_000;

/** What an utterance needs besides its words. */
export interface UtteranceDetail {
  /** The speech recogniser's own pieces, when it revised what it heard. */
  pieces: string[];
  /** The edit model's earlier questions, when this answers one. */
  earlier: Exchange[] | null;
  /** Where the cursor was when it was spoken. */
  anchor: { editor: CodeEditor; anchor: Anchor } | null;
}

/**
 * Makes a request, and if the server can't be reached, waits until it can and tries again,
 * so what was said while it was away isn't lost.
 */
const untilReached = async <T>(
  context: JobContext,
  label: string,
  request: () => Promise<T>,
): Promise<T> => {
  for (;;) {
    context.working(label);
    try {
      return await request();
    } catch (e) {
      if (!(e instanceof ConnectionError)) throw e;
      context.working("Waiting for the server");
      await connection.whenOnline(context.signal);
    }
  }
};

interface Options {
  queue: UtteranceQueue<UtteranceDetail>;
  editor: RefObject<CodeEditor | null>;
  puzzleRef: RefObject<Puzzle | null>;
  /** Utterances spoken while a puzzle's editor is still loading wait for it. */
  editorWaiters: RefObject<((editor: CodeEditor) => void)[]>;
}

/** Queuing what was said, and having the edit model make it, answering its questions. */
export function useEditing({ queue, editor, puzzleRef, editorWaiters }: Options) {
  // The edit model's latest question: its card, and the requests that led to it. Replying to it
  // sends the next utterance as the answer, rather than starting afresh.
  const [question, setQuestion] = useState<{ card: number; exchanges: Exchange[] } | null>(null);
  const [replying, setReplying] = useState(false);
  // Queued utterances run after later renders, so they read the latest state through refs.
  const latest = useRef({ question, replying });
  latest.current = { question, replying };

  /** The editor, waiting for it if a puzzle is open but its editor is still loading. */
  const editorReady = (): Promise<CodeEditor | null> => {
    if (editor.current) return Promise.resolve(editor.current);
    if (puzzleRef.current === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = (ready: CodeEditor) => {
        clearTimeout(timer);
        resolve(ready);
      };
      const timer = setTimeout(() => {
        editorWaiters.current = editorWaiters.current.filter((w) => w !== waiter);
        resolve(null);
      }, EDITOR_WAIT_MS);
      editorWaiters.current.push(waiter);
    });
  };

  const doEdit = async (
    job: Job<UtteranceDetail>,
    earlier: Exchange[],
    context: JobContext,
  ): Promise<Outcome> => {
    const current = await editorReady();
    if (!current) return warn("Open a puzzle first.");
    const { anchor, pieces } = job.detail;
    if (anchor?.editor === current) current.restore(anchor.anchor);
    const marked = current.markedText();
    const before = current.text();
    try {
      const result = await untilReached(context, "Editing", () =>
        api.edit(marked, job.text, pieces, current.recentInsertion, earlier, context.signal),
      );
      if (context.signal.aborted) return { kind: "cancelled" };
      if (editor.current !== current || current.text() !== before) {
        return warn("The code changed while I was thinking, so I left it alone.");
      }
      const seconds = `${(result.elapsed_ms / 1000).toFixed(1)}s`;
      if (result.status === "applied") {
        current.applyMarked(result.doc, result.inserted);
        const model = result.model ? ` · ${result.model.replace(/^claude-/, "")}` : "";
        return done(`${result.summary} · ${seconds}${model}`);
      }
      setQuestion({
        card: job.id,
        exchanges: [...earlier, { said: job.text, asked: result.message }],
      });
      return { kind: "asked", question: result.message };
    } catch (e) {
      if (context.signal.aborted) return { kind: "cancelled" };
      api.log("error", `edit ${JSON.stringify(job.text)}: ${errorMessage(e)}`);
      return { kind: "problem", tone: "error", text: errorMessage(e) };
    }
  };

  /** Queues what was said or typed. `card` is the card already shown while it was said. */
  const enqueue = (text: string, pieces: string[] = [], card?: number) => {
    const { replying, question } = latest.current;
    // Whether answering the question or starting afresh, the question's card has had its turn.
    if (question) queue.dismiss(question.card);
    setQuestion(null);
    setReplying(false);
    const current = editor.current;
    const detail: UtteranceDetail = {
      pieces,
      earlier: replying && question ? question.exchanges : null,
      anchor: current ? { editor: current, anchor: current.anchor() } : null,
    };
    queue.enqueue(text, detail, card);
  };

  return { question, setQuestion, replying, setReplying, doEdit, enqueue };
}
