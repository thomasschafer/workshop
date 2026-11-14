import { request } from "../api";
import type { Draft, PackShown } from "./types";

export const packApi = {
  packs: () => request<{ packs: PackShown[] }>("GET", "/packs").then((r) => r.packs),
  import: (body: {
    pack: string;
    text: string;
    source: string | null;
    skills: string[];
    kind: string | null;
  }) => request<{ draft: Draft; commit: string | null }>("POST", "/packs/import", body),
};
