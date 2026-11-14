import { request } from "../api";
import { utcOffset } from "../learning/local";
import type { DesignListed, DesignOpened, FlaggedCard, MarkedReply, Review, Work } from "./types";

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
  /** Marks written work with the grader; `id` is the attempt's, for work that counts as one. */
  mark: (key: string, id: string, work: Work, text: string) =>
    request<MarkedReply>("POST", `/items/${path(key)}/mark`, { id, work, text }),
  flagged: () => request<{ cards: FlaggedCard[] }>("GET", "/cards/flagged").then((r) => r.cards),
  review: (key: string) =>
    request<{ review: Review; cleared: boolean }>("POST", `/cards/${path(key)}/review`),
  fix: (key: string, approve: boolean) =>
    request<{ commit: string | null }>("POST", `/cards/${path(key)}/fix`, { approve }),
};
