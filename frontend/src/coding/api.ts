import { request, streamLines, type Turn, type VersionedFile } from "../api";
import { utcOffset } from "../learning/local";
import type { Rating } from "../learning/types";
import type { TrackId } from "../tracks/types";
import type {
  Finished,
  Graded,
  Language,
  OfflineBundle,
  Opened,
  OpenedReview,
  Overview,
  ReviewMarked,
  ReviewSession,
  Session,
  Submitted,
  Toolchain,
  TwistMarked,
} from "./types";

const item = (key: string) => {
  const [pack, id] = key.split("/");
  if (!pack || !id) throw new Error(`${key} isn't an item's key`);
  return `/coding/items/${encodeURIComponent(pack)}/${encodeURIComponent(id)}`;
};

const review = (key: string) => {
  const [pack, id] = key.split("/");
  if (!pack || !id) throw new Error(`${key} isn't an item's key`);
  return `/coding/reviews/${encodeURIComponent(pack)}/${encodeURIComponent(id)}`;
};

const toolchain = (language: Language) => `/coding/toolchain/${encodeURIComponent(language)}`;

export const codingApi = {
  /** Whether the Coding track has a language's programs, from mise or Workshop's own PATH. */
  toolchain: (language: Language) => request<Toolchain>("GET", toolchain(language)),
  /** Installs a language's programs with mise, for the Coding track only. */
  installToolchain: (language: Language) =>
    request<Toolchain>("POST", toolchain(language), undefined, { timeoutMs: 0 }),
  cancelToolchainInstall: (language: Language) =>
    request<null>("POST", `${toolchain(language)}/cancel`),
  /** The Coding track's problems and code to read, or another track's with `track`. */
  overview: (track?: TrackId) =>
    request<Overview>(
      "GET",
      `/coding?utc_offset=${utcOffset()}${track ? `&track=${encodeURIComponent(track)}` : ""}`,
    ),
  offlineBundle: () =>
    request<OfflineBundle>("GET", "/coding/offline-bundle", undefined, { timeoutMs: 15_000 }),
  /** Opens a problem, or for a change to review, the review. */
  openItem: (key: string, solve = false) =>
    request<Opened | OpenedReview>("POST", `${item(key)}/open${solve ? "?solve=true" : ""}`),
  /** Opens a problem to solve. */
  open: async (key: string, solve = false): Promise<Opened> => {
    const opened = await codingApi.openItem(key, solve);
    if ("kind" in opened) throw new Error(`${key} is a change to review, not a problem`);
    return opened;
  },
  saveSession: (key: string, session: Session, keepalive = false) =>
    request<Opened>("PUT", `${item(key)}/session`, session, { keepalive }),
  saveCode: (key: string, language: Language, text: string, version: string, keepalive = false) =>
    request<VersionedFile>(
      "PUT",
      `${item(key)}/code/${language}`,
      { text, version },
      { keepalive },
    ),
  /** Saves a file of a project, or adds one. */
  saveFile: (key: string, path: string, text: string, version: string, keepalive = false) =>
    request<VersionedFile>(
      "PUT",
      `${item(key)}/files/${encodeURIComponent(path)}`,
      { text, version },
      { keepalive },
    ),
  saveReview: (key: string, session: ReviewSession, keepalive = false) =>
    request<ReviewSession>("PUT", `${review(key)}/session`, session, { keepalive }),
  /** Has the grader mark a review's comments; `id` is the attempt's. */
  submitReview: (key: string, id: string) =>
    request<ReviewMarked>("POST", `${review(key)}/submit`, { id }, { timeoutMs: 0 }),
  run: (key: string, runId?: string) =>
    request<Graded>("POST", `${item(key)}/run`, runId ? { run_id: runId } : undefined, {
      timeoutMs: 0,
    }),
  submit: (key: string, runId?: string) =>
    request<Submitted>("POST", `${item(key)}/submit`, runId ? { run_id: runId } : undefined, {
      timeoutMs: 0,
    }),
  finish: (key: string, id: string, rating: Rating) =>
    request<Finished>("POST", `${item(key)}/finish`, { id, rating }),
  /** Has the tutor pose the review's twist, or gives the one posed; the review is a recall
   * instead if it can't. */
  twist: (key: string) =>
    request<Opened>("POST", `${item(key)}/twist`, undefined, { timeoutMs: 0 }),
  /** Has the grader mark an answer to the twist, which finishes the review; `id` is the
   * attempt's. With `withCode`, the code is part of the answer. */
  answerTwist: (key: string, id: string, text: string, spoken: boolean, withCode: boolean) =>
    request<TwistMarked>(
      "POST",
      `${item(key)}/twist/answer`,
      {
        id,
        text,
        spoken,
        with_code: withCode,
      },
      { timeoutMs: 0 },
    ),
  /** Brings a retired problem back, due straight away; `id` is the change's. */
  bringBack: (key: string, id: string) =>
    request<Finished>("POST", `${item(key)}/bring-back`, { id }),
  tutor: async (
    key: string,
    body: {
      model: string;
      turns: Turn[];
      code: string;
      errors: string;
      last_run: string;
      file?: string | null;
    },
    onDelta: (text: string) => void,
  ): Promise<{ text: string }> => {
    let reply: string | null = null;
    await streamLines("POST", `${item(key)}/tutor`, body, (line) => {
      const event = line as { delta: string } | { done: { text: string } } | { error: string };
      if ("delta" in event) onDelta(event.delta);
      else if ("done" in event) reply = event.done.text;
      else throw new Error(event.error);
    });
    if (reply === null) throw new Error("The reply stopped before it was finished.");
    return { text: reply };
  },
};
