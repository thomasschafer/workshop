import { request } from "../api";
import { utcOffset } from "../learning/local";
import type { Beat, Ended, Opened, Overview } from "./types";

const round = (key: string) => {
  const [pack, item] = key.split("/");
  if (!pack || !item) throw new Error(`${key} isn't an item's key`);
  return `/rounds/${encodeURIComponent(pack)}/${encodeURIComponent(item)}`;
};

export const roundsApi = {
  overview: () => request<Overview>("GET", `/rounds?utc_offset=${utcOffset()}`),
  /** An item to make a round of, and the round under way, whose clock opening it runs. */
  open: (key: string) => request<Opened>("POST", `${round(key)}/open`, {}),
  /** Starts a round, with the clock running from now, or carries on with the one under way. */
  start: (key: string, style: string | null) =>
    request<Opened>("POST", `${round(key)}/start`, { style }),
  /** Says the round is still open, with the working as it is. */
  beat: (key: string, work: string, keepalive = false) =>
    request<Beat>("POST", `${round(key)}/beat`, { work }, { keepalive }),
  /** Says something to the examiner, and gets its reply. */
  say: (key: string, text: string, work: string) =>
    request<Opened>("POST", `${round(key)}/say`, { text, work }, { timeoutMs: 0 }),
  /** Ends the round, if it's still on, and has the grader mark it; `id` is the attempt's. */
  end: (key: string, id: string, work: string | null) =>
    request<Ended>("POST", `${round(key)}/end`, { id, work }, { timeoutMs: 0 }),
};
