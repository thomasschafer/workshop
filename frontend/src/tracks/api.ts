import { request } from "../api";
import type { Home } from "./types";

export const tracksApi = {
  home: () => request<Home>("GET", "/home"),
};
