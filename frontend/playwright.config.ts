import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { createHome, HOME, PORT } from "./e2e/fixture";

// Playwright loads this file in each of its processes; the home must only be built once, before
// the server starts.
if (process.env.WORKSHOP_E2E_HOME_READY === undefined) {
  createHome();
  process.env.WORKSHOP_E2E_HOME_READY = "1";
}

const binary = resolve(import.meta.dirname, "..", "target", "debug", "workshop");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Pixel 7"],
    // A desktop pointer shows the box for typing what you'd say, which stands in for speech.
    hasTouch: false,
    isMobile: false,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
      : {},
  },
  webServer: {
    command: `${binary} serve`,
    env: {
      WORKSHOP_HOME: HOME,
      // A stand-in for Whisper, used once a test puts its model in place.
      PATH: `${resolve(import.meta.dirname, "e2e", "bin")}:${process.env.PATH ?? ""}`,
      RUST_LOG: "workshop=warn",
      // So committing works wherever the tests run, with or without a git identity set up.
      GIT_AUTHOR_NAME: "Workshop tests",
      GIT_AUTHOR_EMAIL: "tests@example.com",
      GIT_COMMITTER_NAME: "Workshop tests",
      GIT_COMMITTER_EMAIL: "tests@example.com",
    },
    url: `http://127.0.0.1:${PORT}/api/bootstrap`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
