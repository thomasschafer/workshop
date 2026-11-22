import { request } from "../api";
import { utcOffset } from "../learning/local";
import type {
  DesignEdit,
  DesignListed,
  DesignMarked,
  DesignOpened,
  DesignSession,
  Exchange,
  FlaggedCard,
  MarkedReply,
  Review,
  Stage,
  Work,
} from "./types";

const path = (key: string) => {
  const [pack, item] = key.split("/");
  if (!pack || !item) throw new Error(`${key} isn't an item's key`);
  return `${encodeURIComponent(pack)}/${encodeURIComponent(item)}`;
};

export const gradingApi = {
  designs: () =>
    request<{ items: DesignListed[] }>("GET", `/design?utc_offset=${utcOffset()}`).then(
      (r) => r.items,
    ),
  design: (key: string) => request<DesignOpened>("GET", `/design/${path(key)}`),
  /** Starts a design session, or carries on with the one started. */
  startDesign: (key: string) =>
    request<DesignOpened>("POST", `/design/${path(key)}/start`, undefined, { timeoutMs: 0 }),
  saveDesign: (key: string, edit: DesignEdit, keepalive = false) =>
    request<DesignSession>("PUT", `/design/${path(key)}/session`, edit, { keepalive }),
  /**
   * Talks with the coach at a stage: where the learner asks, `reply` is their question, which it
   * answers, or null to have it answer the one left unanswered; elsewhere, it asks follow-up
   * questions, after the learner's reply, if any.
   */
  coach: (key: string, stage: Stage, reply: string | null) =>
    request<DesignSession>(
      "POST",
      `/design/${path(key)}/coach`,
      { stage, reply },
      { timeoutMs: 0 },
    ),
  /** Has the grader mark the whole session, which ends it; `id` is the attempt's. */
  finishDesign: (key: string, id: string) =>
    request<DesignMarked>("POST", `/design/${path(key)}/finish`, { id }, { timeoutMs: 0 }),
  /**
   * Marks work with the grader, written or, if `spoken`, what was heard explaining it aloud;
   * `id` is the attempt's, for work that counts as one.
   */
  mark: (key: string, id: string, work: Work, text: string, spoken = false) =>
    request<MarkedReply>(
      "POST",
      `/items/${path(key)}/mark`,
      { id, work, text, spoken },
      { timeoutMs: 0 },
    ),
  /** The follow-up questions under way on a card, if there are any. */
  followUps: (key: string) =>
    request<{ exchange: Exchange | null }>("GET", `/cards/${path(key)}/follow-ups`).then(
      (r) => r.exchange,
    ),
  /**
   * Starts follow-up questions on a card with the learner's answer, and has the tutor ask its
   * first. `id` is the exchange's, the same each time it's sent. If the card has follow-ups under
   * way already, it's those, with an id of their own.
   */
  startFollowUps: (key: string, id: string, text: string, spoken: boolean) =>
    request<Exchange>(
      "POST",
      `/cards/${path(key)}/follow-ups/start`,
      { id, text, spoken },
      { timeoutMs: 0 },
    ),
  /**
   * Replies to the tutor's question, counting from 0, of the exchange it's for, and, unless `ask`
   * is false, has the tutor ask its next. Sent again, the same reply is taken once.
   */
  replyToFollowUp: (
    key: string,
    exchange: string,
    question: number,
    text: string,
    spoken: boolean,
    ask = true,
  ) =>
    request<Exchange>(
      "POST",
      `/cards/${path(key)}/follow-ups/reply`,
      { exchange, question, text, spoken, ask },
      { timeoutMs: 0 },
    ),
  /** Has the tutor ask the question it couldn't before. */
  askFollowUp: (key: string, exchange: string) =>
    request<Exchange>("POST", `/cards/${path(key)}/follow-ups/ask`, { exchange }, { timeoutMs: 0 }),
  /**
   * Has the grader mark a card's follow-ups, which ends them, as an attempt with the exchange's
   * id. Asked again, as after a lost reply, it gives the same marks.
   */
  finishFollowUps: (key: string, exchange: string) =>
    request<MarkedReply>(
      "POST",
      `/cards/${path(key)}/follow-ups/finish`,
      { exchange },
      { timeoutMs: 0 },
    ),
  flagged: () => request<{ cards: FlaggedCard[] }>("GET", "/cards/flagged").then((r) => r.cards),
  review: (key: string) =>
    request<{ review: Review; cleared: boolean }>("POST", `/cards/${path(key)}/review`, undefined, {
      timeoutMs: 0,
    }),
  fix: (key: string, approve: boolean) =>
    request<{ commit: string | null }>(
      "POST",
      `/cards/${path(key)}/fix`,
      { approve },
      { timeoutMs: 0 },
    ),
};
