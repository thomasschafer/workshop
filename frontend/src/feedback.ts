/** What's shown above the talk button: what was heard, and what happened. */
export interface Feedback {
  kind: "pending" | "ok" | "warn" | "error" | "info";
  transcript?: string;
  text: string;
}
