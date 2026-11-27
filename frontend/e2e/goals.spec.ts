import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import { GOALS_HOME, GOALS_PORT } from "./fixture";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;

const token = () => readFileSync(join(GOALS_HOME, "config", "token"), "utf8").trim();

const DAY_MS = 24 * 60 * 60 * 1000;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${GOALS_PORT}`,
  });
  phone = await context.newPage();
  await phone.goto(`/?token=${token()}`);
});

test.afterAll(async () => {
  await context?.close();
});

test("shows each skill's coverage beside its recall on a phone", async () => {
  // Done on another device over the last few days: the processes lesson, then one of its cards
  // answered right a day later, which covers its topic; the virtual memory lesson, with nothing
  // answered since; and one file systems card right, one wrong.
  const now = Date.now();
  const attempt = (item: string, daysAgo: number, rating: string) => ({
    id: crypto.randomUUID(),
    item: `outline/${item}`,
    answered_at: now - daysAgo * DAY_MS,
    duration_ms: 5000,
    rating,
  });
  const done = (lesson: string, daysAgo: number) => ({
    id: crypto.randomUUID(),
    lesson: `outline/${lesson}`,
    completed_at: now - daysAgo * DAY_MS,
    duration_ms: 120_000,
  });
  const synced = await phone.request.post("/api/learning/sync", {
    data: {
      lesson_completions: [done("processes", 3), done("virtual-memory", 1)],
      attempts: [
        attempt("fork", 2, "good"),
        attempt("inodes", 2, "good"),
        attempt("journaling", 2, "again"),
      ],
    },
  });
  expect(synced.ok()).toBe(true);

  await phone.getByRole("button", { name: /^Goals/ }).tap();
  await expect(phone).toHaveURL(/\/goals$/);
  await phone.getByRole("button", { name: /^Systems basics/ }).tap();
  await expect(phone).toHaveURL(/\/goals\/systems-basics$/);
  await expect(phone.getByRole("region", { name: "Summary" })).toContainText(
    "Each skill 60% covered, recall 80%",
  );

  const skill = (name: string) => phone.locator(".goal-skill").filter({ hasText: name });
  // A third of its topics are covered; the untaught card isn't counted against its recall, but
  // the one taught and not yet tried is.
  const os = skill("Operating systems");
  await expect(os.locator(".goal-skill-standing")).toHaveText(/^33% covered · recall \d+%$/);
  await expect(os).toContainText("1 of 3 topics covered · 1 of 2 items tried");
  await expect(phone.getByLabel("Operating systems covered")).toBeVisible();
  await expect(phone.getByLabel("Operating systems recall")).toBeVisible();
  // Without topics, it's the share of its items answered right.
  const files = skill("File systems");
  await expect(files.locator(".goal-skill-standing")).toHaveText(/^50% covered · recall \d+%$/);
  await expect(files).toContainText("2 of 2 items tried");
  // Nothing covered says so, with no empty bars that look like a skill never started.
  const networks = skill("Networks");
  await expect(networks.locator(".goal-skill-standing")).toHaveText("Nothing covered yet");
  await expect(networks).toContainText("0 of 2 topics covered · 0 of 1 item tried");
  await expect(networks.locator("meter")).toHaveCount(0);

  // The trend shows both, and the weakest come by the lower of the two.
  await expect(
    phone.getByRole("img", {
      name: /^Average coverage went from 0% to 28%, and recall from 0% to \d+%, against targets of 60% covered and 80% recall$/,
    }),
  ).toBeVisible();
  await expect(phone.locator(".goal-trend figcaption")).toContainText("Covered 28%, from 0%");
  await expect(phone.locator(".goal-weakest")).toHaveText(
    "Networks, Operating systems, File systems",
  );

  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
});
