/** What went wrong, for showing to the user, from anything a promise rejected or code threw. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
