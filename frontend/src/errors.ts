/**
 * What went wrong, for showing to the user, from anything a promise rejected or code threw,
 * including a language server's error, which the language client rejects with as it came, as an
 * object with a message.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") {
    return e.message;
  }
  return String(e);
}
