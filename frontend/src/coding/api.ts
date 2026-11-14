import { request, streamLines, type Turn, type VersionedFile } from "../api";
import { utcOffset } from "../learning/local";
import type { Rating } from "../learning/types";
import type { Graded, Language, Opened, Overview, Session, Submitted } from "./types";

const item = (key: string) => {
  const [pack, id] = key.split("/");
  if (!pack || !id) throw new Error(`${key} isn't an item's key`);
  return `/coding/items/${encodeURIComponent(pack)}/${encodeURIComponent(id)}`;
};

export const codingApi = {
  overview: () => request<Overview>("GET", `/coding?utc_offset=${utcOffset()}`),
  open: (key: string, solve = false) =>
    request<Opened>("POST", `${item(key)}/open${solve ? "?solve=true" : ""}`),
  saveSession: (key: string, session: Session, keepalive = false) =>
    request<Opened>("PUT", `${item(key)}/session`, session, { keepalive }),
  saveCode: (key: string, language: Language, text: string, version: string, keepalive = false) =>
    request<VersionedFile>(
      "PUT",
      `${item(key)}/code/${language}`,
      { text, version },
      { keepalive },
    ),
  run: (key: string) => request<Graded>("POST", `${item(key)}/run`),
  submit: (key: string) => request<Submitted>("POST", `${item(key)}/submit`),
  finish: (key: string, id: string, rating: Rating) =>
    request<{ due: number | null }>("POST", `${item(key)}/finish`, { id, rating }),
  tutor: async (
    key: string,
    body: { model: string; turns: Turn[]; code: string; errors: string; last_run: string },
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
