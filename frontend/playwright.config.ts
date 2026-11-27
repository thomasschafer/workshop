import { delimiter, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  AUTHOR_HOME,
  AUTHOR_PORT,
  CODEBASE_HOME,
  CODEBASE_PORT,
  CODING_HOME,
  CODING_PORT,
  createAuthorHome,
  createCodebaseHome,
  createCodingHome,
  createGoalsHome,
  createHome,
  createLearningHome,
  createLessonsHome,
  GOALS_HOME,
  GOALS_PORT,
  HOME,
  LEARNING_HOME,
  LEARNING_PORT,
  LESSONS_HOME,
  LESSONS_PORT,
  PORT,
} from "./e2e/fixture";

// Playwright loads this file in each of its processes; the home must only be built once, before
// the server starts.
if (process.env.WORKSHOP_E2E_HOME_READY === undefined) {
  createHome();
  createLearningHome();
  createCodingHome();
  createAuthorHome();
  createCodebaseHome();
  createLessonsHome();
  createGoalsHome();
  process.env.WORKSHOP_E2E_HOME_READY = "1";
}

const binary = resolve(import.meta.dirname, "..", "target", "debug", "workshop");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  // CI's runners vary in speed, so on CI a failed test gets a second go. One that passes then is
  // reported as flaky rather than passed, and `scripts/ci-flakes` lists them across recent runs, so
  // they're still found and fixed.
  retries: process.env.CI ? 1 : 0,
  // On CI, the list too, so each test's output, and the servers' with it, is in the job's log.
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    // Kept in `test-results`, which CI uploads when a test fails. Traces would show more, but
    // recording them for every test slows the run enough to change the timing of what's tested.
    screenshot: "only-on-failure",
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Pixel 7"],
    // A desktop pointer shows the box for typing what you'd say, which stands in for speech.
    hasTouch: false,
    isMobile: false,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
          : {},
      },
    },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: [
    { home: HOME, port: PORT },
    { home: LEARNING_HOME, port: LEARNING_PORT },
    { home: CODING_HOME, port: CODING_PORT },
    { home: AUTHOR_HOME, port: AUTHOR_PORT },
    { home: CODEBASE_HOME, port: CODEBASE_PORT },
    { home: LESSONS_HOME, port: LESSONS_PORT },
    { home: GOALS_HOME, port: GOALS_PORT },
  ].map(({ home, port }) => ({
    command: `${binary} serve`,
    env: {
      WORKSHOP_HOME: home,
      // A stand-in for Whisper, used once a test puts its model in place.
      PATH: `${resolve(import.meta.dirname, "e2e", "bin")}${delimiter}${process.env.PATH ?? ""}`,
      RUST_LOG: "workshop=warn",
      // So committing works wherever the tests run, with or without a git identity set up.
      GIT_AUTHOR_NAME: "Workshop tests",
      GIT_AUTHOR_EMAIL: "tests@example.com",
      GIT_COMMITTER_NAME: "Workshop tests",
      GIT_COMMITTER_EMAIL: "tests@example.com",
    },
    url: `http://127.0.0.1:${port}/api/bootstrap`,
    reuseExistingServer: false,
    // So the server stops what it started, such as whisper-server, as it would when stopped by hand.
    gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5000 },
    timeout: 30_000,
  })),
});
