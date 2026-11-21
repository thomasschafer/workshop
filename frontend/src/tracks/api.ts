import { request } from "../api";
import { utcOffset } from "../learning/local";
import type { Home } from "./types";

export const tracksApi = {
  /** The home screen, offering long items only if the learner has a while. */
  home: (aWhile: boolean) =>
    request<Home>(
      "GET",
      `/home?utc_offset=${utcOffset()}${aWhile ? "&time=a_while" : ""}`,
      undefined,
      { timeoutMs: 5_000 },
    ),
};
