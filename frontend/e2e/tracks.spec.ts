import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import { CODING_HOME, CODING_PORT, DRILLS_PACK } from "./fixture";

// A pack's track kept out of Continue, Drills, on the Coding track's server, beside the sample
// pack: its cards, code to read and problem are only offered once it's opened.
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;

const token = () => readFileSync(join(CODING_HOME, "config", "token"), "utf8").trim();

interface DeckProgress {
  reviews_today: number;
  new_today: number;
  minutes_this_week: number;
}

/** What the server says has been done, on everything else and in Drills. */
async function done(): Promise<{ rest: DeckProgress; drills: DeckProgress | null }> {
  const response = await phone.request.get("/api/learning/deck?utc_offset=0");
  expect(response.ok()).toBe(true);
  const deck = (await response.json()) as {
    progress: DeckProgress;
    tracks: { id: string; kept_apart: boolean; progress: DeckProgress | null }[];
  };
  const drills = deck.tracks.find((track) => track.id === "pack:drills");
  expect(drills?.kept_apart).toBe(true);
  return { rest: deck.progress, drills: drills?.progress ?? null };
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${CODING_PORT}`,
  });
  phone = await context.newPage();
  await phone.goto(`/?token=${token()}`);
});

test.afterAll(async () => {
  await context?.close();
});

test("lists a track kept to itself at home, but never continues with it", async () => {
  const drills = phone.locator(".track", { hasText: "Drills" });
  await expect(drills).toContainText("4 new");
  await expect(drills.locator('[data-icon="puzzle"]')).toBeVisible();
  const next = phone.locator(".continue");
  await expect(next).toBeVisible();
  await expect(next).not.toContainText("Drills");
  // Nor when there's a while for something long.
  await phone.getByRole("switch", { name: /I've got a while/ }).check();
  await expect(next).not.toContainText("Drills");
  await phone.getByRole("switch", { name: /I've got a while/ }).uncheck();
});

test("practises its cards and code to read once it's opened, with limits of its own", async () => {
  const before = await done();
  await phone.locator(".track", { hasText: "Drills" }).tap();
  await expect(phone).toHaveURL(/\/practice\/pack%3Adrills$/);
  await expect(phone.locator(".app-title")).toContainText("Drills");
  await expect(phone.locator(".learn-count")).toHaveText("1 of 3");
  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "Forgot" }).tap();
  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "Good" }).tap();
  // Code to read, highlighted as Python.
  await expect(phone.locator(".learn-prompt .syntax-keyword").first()).toHaveText("for");
  await phone.getByLabel("What it prints").fill("14");
  await phone.getByRole("button", { name: "Check" }).tap();
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await phone.getByRole("button", { name: "Got it" }).tap();
  await expect(phone.getByRole("heading", { name: /That's a step done/ })).toBeVisible();
  await expect(phone.locator(".learn-done")).toContainText(
    "minutes here this week, kept apart from the week's target",
  );
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  // Counted towards its own limits, and not the rest's.
  const after = await done();
  expect(after.rest).toEqual(before.rest);
  expect(after.drills?.new_today).toBe((before.drills?.new_today ?? 0) + 3);
  // The card forgotten is in the mistake log, and counts towards the pack's goal.
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { item: string }[];
  };
  expect(log.mistakes.some((m) => m.item.startsWith(`${DRILLS_PACK}/`))).toBe(true);
  const goals = (await (await phone.request.get("/api/goals?utc_offset=0")).json()) as {
    goals: { id: string; skills: { attempted: number }[] }[];
  };
  const goal = goals.goals.find((g) => g.id === "drilled-sums");
  expect(goal?.skills[0]?.attempted).toBeGreaterThan(0);
});

test("lists its problem, which is worked on from the track and leads back to it", async () => {
  const problems = phone.getByRole("region", { name: "Problems" });
  const problem = problems.locator(".coding-item", { hasText: "Add them up" });
  await expect(problem).toContainText("Problem · New");
  await problem.tap();
  await expect(phone).toHaveURL(/\/coding\/drills\/add-them-up$/);
  await expect(phone.locator(".step.current")).toHaveText("Understand");
  await phone.getByLabel("What should it print?").fill("3");
  await phone.getByRole("button", { name: "Check" }).tap();
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  // Its way back is to Drills, with the track's icon, not the Coding track.
  const back = phone.getByRole("banner").getByRole("button", { name: "Drills" });
  await expect(back.locator('[data-icon="puzzle"]')).toBeVisible();
  await back.tap();
  await expect(phone).toHaveURL(/\/practice\/pack%3Adrills$/);
  await expect(
    phone.getByRole("region", { name: "Problems" }).locator(".coding-item", {
      hasText: "Add them up",
    }),
  ).toContainText("In progress · Understand");
  // Left part-way through, it's still not where Continue goes, nor in the Coding track.
  await phone.getByRole("banner").getByRole("button", { name: "Home" }).tap();
  await expect(phone.locator(".continue")).not.toContainText("Add them up");
  const coding = (await (await phone.request.get("/api/coding?utc_offset=0")).json()) as {
    items: { key: string }[];
  };
  expect(coding.items.some((item) => item.key.startsWith(`${DRILLS_PACK}/`))).toBe(false);
});
