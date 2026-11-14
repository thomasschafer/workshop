import { request } from "../api";
import { utcOffset } from "../learning/local";
import type { Home } from "./types";

export const tracksApi = {
  home: () => request<Home>("GET", `/home?utc_offset=${utcOffset()}`),
};
