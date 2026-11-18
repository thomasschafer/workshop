// Copies each end-to-end test server's log into `test-results/server-logs`, for CI to keep with
// the failure screenshots when a browser test fails. The servers write warnings and errors there,
// which say why a request failed or a language server stopped. Homes that were never created, such
// as when the tests stopped before starting a server, are skipped.
//
// Run from `frontend` with `node scripts/collect-e2e-logs.ts`.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AUTHOR_HOME, CODING_HOME, HOME, LEARNING_HOME } from "../e2e/fixture.ts";

const destination = resolve(import.meta.dirname, "..", "test-results", "server-logs");
mkdirSync(destination, { recursive: true });
for (const home of [HOME, LEARNING_HOME, CODING_HOME, AUTHOR_HOME]) {
  const log = join(home, "data", "workshop.log");
  if (existsSync(log)) {
    cpSync(log, join(destination, `${basename(home)}.log`));
    console.log(`Kept ${log}`);
  } else {
    console.log(`No log at ${log}`);
  }
}
