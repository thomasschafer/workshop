import { api, type Puzzle } from "../api";
import { useConversation } from "./useConversation";

/** What the discussion model is shown alongside the conversation. */
export interface DiscussContext {
  code: string;
  errors: string;
  lastRun: string;
}

/** A conversation about the current puzzle, kept per puzzle on this device. */
export function useDiscussion(puzzle: Puzzle | null, model: string, context: () => DiscussContext) {
  return useConversation(
    puzzle ? `workshop:discuss:${puzzle.year}:${puzzle.day}` : null,
    (turns, onDelta) => {
      if (!puzzle) throw new Error("Open a puzzle before discussing it.");
      const { code, errors, lastRun } = context();
      return api.discuss(
        {
          year: puzzle.year,
          day: puzzle.day,
          model,
          turns,
          code,
          errors,
          last_run: lastRun,
        },
        onDelta,
      );
    },
    "Open a puzzle before discussing it.",
  );
}
