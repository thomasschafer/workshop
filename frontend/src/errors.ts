/**
 * What went wrong, for showing to the user, from anything a promise rejected or code threw,
 * including an object with a message that isn't an Error, such as a language server's JSON-RPC
 * error as the LSP library rejects with it.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") {
    return e.message;
  }
  return String(e);
}
