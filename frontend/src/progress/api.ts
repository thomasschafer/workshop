import { request } from "../api";
import { utcOffset } from "../learning/local";
import type { GoalProgress, MistakeLog } from "./types";

export const progressApi = {
  goals: () =>
    request<{ goals: GoalProgress[] }>("GET", `/goals?utc_offset=${utcOffset()}`).then(
      (r) => r.goals,
    ),
  mistakes: () => request<MistakeLog>("GET", `/mistakes?utc_offset=${utcOffset()}`),
  /** Sets the kind of a mistake, or with null goes back to the one suggested. */
  tag: (id: string, errorType: string | null) =>
    request<MistakeLog>("PUT", `/mistakes/tag?utc_offset=${utcOffset()}`, {
      id,
      error_type: errorType,
    }),
};
