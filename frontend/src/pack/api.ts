import { request } from "../api";
import type { AuthorStatus, Draft, PackShown } from "./types";

export const packApi = {
  author: () => request<AuthorStatus>("GET", "/author"),
  topUp: () => request<AuthorStatus>("POST", "/author/run"),
  decide: (id: string, approve: boolean) =>
    request<{ commit: string | null; status: AuthorStatus }>(
      "POST",
      `/author/queue/${encodeURIComponent(id)}`,
      { approve },
    ),
  answer: (id: string, answer: string) =>
    request<AuthorStatus>("POST", `/author/questions/${encodeURIComponent(id)}`, { answer }),
  packs: () => request<{ packs: PackShown[] }>("GET", "/packs").then((r) => r.packs),
  import: (body: {
    pack: string;
    text: string;
    source: string | null;
    skills: string[];
    kind: string | null;
  }) => request<{ draft: Draft; commit: string | null }>("POST", "/packs/import", body),
};
