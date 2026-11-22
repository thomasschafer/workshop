// What a card's follow-up questions work out on the device: what's been said, in order, how
// the next reply is given, and the reply being written, kept until the server has it.

import type { Exchange, Said } from "./types";

/** Something said in an exchange, in the order it was said. */
export interface Turn {
  who: "learner" | "tutor";
  text: string;
  /** For the learner's, whether it was explained aloud. */
  spoken: boolean;
}

export function turnsOf(exchange: Exchange): Turn[] {
  const learner = (said: Said): Turn => ({ who: "learner", text: said.text, spoken: said.spoken });
  const turns = [learner(exchange.answer)];
  for (const question of exchange.questions) {
    turns.push({ who: "tutor", text: question.text, spoken: false });
    if (question.reply) turns.push(learner(question.reply));
  }
  return turns;
}

/** How a reply is given: written, typed or dictated, or explained aloud, to be marked for clarity. */
export type Mode = "writing" | "aloud";

/** The way the learner said the last thing they did, for them to reply the same way. */
export function modeOf(exchange: Exchange): Mode {
  const said = [exchange.answer, ...exchange.questions.flatMap((q) => q.reply ?? [])];
  return said[said.length - 1]?.spoken ? "aloud" : "writing";
}

/** The question waiting for the learner's reply, counting from 0, or null if none is. */
export function waiting(exchange: Exchange): number | null {
  const last = exchange.questions.length - 1;
  return exchange.next === "reply" && last >= 0 && !exchange.questions[last]?.reply ? last : null;
}

/** Whether the server has the learner's reply to a question. */
export function replied(exchange: Exchange, question: number): boolean {
  return Boolean(exchange.questions[question]?.reply);
}

/** A reply being written, kept on the device until it's sent, so closing the app keeps it. */
export interface Draft {
  /** The exchange it's for, by its id. */
  exchange: string;
  /** The question it replies to, counting from 0. */
  question: number;
  text: string;
  mode: Mode;
}

const draftKey = (key: string) => `workshop:unsaved:follow-ups:${key}`;

/** The reply kept for the question waiting on a card, if there is one. */
export function readDraft(storage: Storage, key: string, exchange: Exchange): Draft | null {
  try {
    const raw = storage.getItem(draftKey(key));
    const draft = raw ? (JSON.parse(raw) as Draft) : null;
    return draft && draft.exchange === exchange.id && draft.question === waiting(exchange)
      ? draft
      : null;
  } catch {
    return null;
  }
}

export function writeDraft(storage: Storage, key: string, draft: Draft | null): void {
  try {
    if (draft === null || !draft.text.trim()) storage.removeItem(draftKey(key));
    else storage.setItem(draftKey(key), JSON.stringify(draft));
  } catch {
    // Storage can be full or disabled; the reply is still sent when it's given.
  }
}
