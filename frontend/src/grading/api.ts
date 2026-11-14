import { request } from "../api";
import { utcOffset } from "../learning/local";
import type {
  DesignEdit,
  DesignListed,
  DesignOpened,
  DesignSession,
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
  startDesign: (key: string) => request<DesignOpened>("POST", `/design/${path(key)}/start`),
  saveDesign: (key: string, edit: DesignEdit, keepalive = false) =>
    request<DesignSession>("PUT", `/design/${path(key)}/session`, edit, { keepalive }),
  /** Has the coach ask follow-up questions at a stage, after the learner's reply, if any. */
  coach: (key: string, stage: Stage, reply: string | null) =>
    request<DesignSession>("POST", `/design/${path(key)}/coach`, { stage, reply }),
  /** Has the grader mark the whole session, which ends it; `id` is the attempt's. */
  finishDesign: (key: string, id: string) =>
    request<MarkedReply>("POST", `/design/${path(key)}/finish`, { id }),
  /**
   * Marks work with the grader, written or, if `spoken`, what was heard explaining it aloud;
   * `id` is the attempt's, for work that counts as one.
   */
  mark: (key: string, id: string, work: Work, text: string, spoken = false) =>
    request<MarkedReply>("POST", `/items/${path(key)}/mark`, { id, work, text, spoken }),
  flagged: () => request<{ cards: FlaggedCard[] }>("GET", "/cards/flagged").then((r) => r.cards),
  review: (key: string) =>
    request<{ review: Review; cleared: boolean }>("POST", `/cards/${path(key)}/review`),
  fix: (key: string, approve: boolean) =>
    request<{ commit: string | null }>("POST", `/cards/${path(key)}/fix`, { approve }),
};
