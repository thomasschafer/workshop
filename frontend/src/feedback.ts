/** What's shown above the talk button: what was heard, and what happened. */
export type Feedback =
  | {
      /** The edit model is working on what was said. */
      kind: "pending";
      transcript: string;
      /** When the request started, from `performance.now()`. */
      startedAt: number;
    }
  | {
      kind: "ok" | "warn" | "error" | "info";
      transcript?: string;
      text: string;
    };
