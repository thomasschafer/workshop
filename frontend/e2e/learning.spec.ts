import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import { LEARNING_HOME, LEARNING_PORT } from "./fixture";

// The tests share one phone and run in order, like one learner using the app, from a server
// that starts with nothing done and the sample pack.
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;

const token = () => readFileSync(join(LEARNING_HOME, "config", "token"), "utf8").trim();

interface Deck {
  items: {
    key: string;
    kind: string;
    prompt: string;
    answer?: number;
    instances?: { prompt: string; answer: number }[];
  }[];
  schedules: Record<string, { reviews: number }>;
  flags: Record<string, { note: string | null }>;
}

/** The deck as the server has it now, which is what it's learnt from the attempts it's been sent. */
async function serverDeck(): Promise<Deck> {
  const response = await phone.request.get("/api/learning/deck");
  expect(response.ok()).toBe(true);
  return (await response.json()) as Deck;
}

/** The answer to the question showing, from the deck the phone keeps. */
async function answerShown(on: Page = phone): Promise<string> {
  const shown = (await on.locator(".learn-prompt").innerText()).trim();
  return on.evaluate((prompt) => {
    const saved = JSON.parse(localStorage.getItem("workshop:learning") ?? "null") as {
      deck: Deck;
    };
    for (const item of saved.deck.items) {
      if (
        item.kind === "probability" &&
        item.prompt.replace(/\s+/g, " ") === prompt.replace(/\s+/g, " ")
      ) {
        return String(item.answer);
      }
      const instance = item.instances?.find((i) => i.prompt === prompt);
      if (instance) return String(instance.answer);
    }
    throw new Error(`no item in the deck asks ${JSON.stringify(prompt)}`);
  }, shown);
}

/** How many items the server has a schedule for, as it learns of attempts. */
async function scheduled(kind?: string): Promise<number> {
  const deck = await serverDeck();
  return Object.keys(deck.schedules).filter(
    (key) =>
      kind === undefined || deck.items.some((item) => item.key === key && item.kind === kind),
  ).length;
}

async function goHome(): Promise<void> {
  await phone.getByRole("banner").getByRole("button", { name: "Home" }).tap();
  await expect(phone).toHaveURL(/\/$/);
}

async function answer(text: string, on: Page = phone): Promise<void> {
  await on.getByLabel("Your answer").fill(text);
  await on.getByRole("button", { name: "Check" }).tap();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LEARNING_PORT}`,
  });
  phone = await context.newPage();
  await phone.goto(`/?token=${token()}`);
});

test.afterAll(async () => {
  await context?.close();
});

test("shows the pack's tracks at home, and continues with something new", async () => {
  await expect(phone.locator(".track")).toHaveCount(6);
  const names = await phone.locator(".track-name").allInnerTexts();
  expect(names).toEqual([
    "Advent of Code",
    "Coding",
    "Probability",
    "Mental maths",
    "Review",
    "Estimation",
  ]);
  await expect(phone.locator(".track", { hasText: "Review" })).toContainText("10 new");
  // Nothing's due yet, so Continue offers something new, in the first track with any: the
  // quickest of the Coding track's, some code to read.
  const next = phone.locator(".continue");
  await expect(next).toContainText("Counting copies");
  await expect(next).toContainText("Coding · Something new · 0 of 90 minutes this week");
  await expect(phone.getByLabel("This week's practice")).toBeVisible();
  // It all fits across a phone's screen.
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
});

test("reviews cards a few at a time, saving each, and flags one that's wrong", async () => {
  await phone.locator(".track", { hasText: "Review" }).tap();
  await expect(phone).toHaveURL(/\/practice\/review$/);
  await expect(phone.locator(".learn-count")).toHaveText("1 of 3");

  await phone.getByRole("button", { name: "Show answer" }).tap();
  await expect(phone.getByRole("region", { name: "Answer" })).toBeVisible();
  await phone.getByRole("button", { name: "Good" }).tap();
  await expect(phone.locator(".learn-count")).toHaveText("2 of 3");
  // Saved as soon as it's marked, so the learner can stop at any moment.
  await expect.poll(() => scheduled()).toBe(1);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");

  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "This is wrong" }).tap();
  await phone.getByLabel("What's wrong? (optional)").fill("The example contradicts the answer");
  await phone.getByRole("button", { name: "Flag it" }).tap();

  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "Forgot" }).tap();
  await expect(phone.getByRole("heading", { name: "That's a step done" })).toBeVisible();
  await expect(phone.getByLabel(/mastered$/).first()).toBeVisible();

  await expect.poll(() => scheduled()).toBe(2);
  await expect
    .poll(async () => Object.values((await serverDeck()).flags).map((flag) => flag.note))
    .toEqual(["The example contradicts the answer"]);

  // The flagged card is left out, and the rest go on.
  await goHome();
  await expect(phone.locator(".track", { hasText: "Review" })).toContainText("7 new · 1 flagged");
});

test("checks mental maths as it's typed, right or wrong", async () => {
  await phone.locator(".track", { hasText: "Mental maths" }).tap();
  await expect(phone.locator(".learn-count")).toHaveText("1 of 3");
  // Phones offer a keypad for numbers.
  await expect(phone.getByLabel("Your answer")).toHaveAttribute("inputmode", "decimal");

  await answer("lots");
  await expect(phone.getByText("Type a number, such as 42, 0.25, 1/4 or 25%.")).toBeVisible();
  const right = await answerShown();
  await answer("0");
  await expect(phone.locator(".learn-verdict")).toHaveText(`The answer is ${right}`);
  await phone.getByRole("button", { name: "Next" }).tap();

  await answer(await answerShown());
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await phone.getByRole("button", { name: "Next" }).tap();
  await phone.getByRole("button", { name: "I don't know" }).tap();
  await expect(phone.locator(".learn-verdict")).toContainText("The answer is");
  await phone.getByRole("button", { name: "Next" }).tap();
  await expect(
    phone.getByRole("heading", { name: "That's a step done: 1 of 3 right" }),
  ).toBeVisible();
  await expect.poll(() => scheduled("mental-maths")).toBe(3);
});

test("keeps a log of mistakes, whose kinds can be confirmed or changed", async () => {
  await goHome();
  await phone.getByRole("button", { name: /^Mistakes/ }).tap();
  await expect(phone).toHaveURL(/\/mistakes$/);
  // The card forgotten, and the two sums gone wrong.
  const rows = phone.getByRole("list", { name: "Mistakes" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  const unknown = rows.filter({ hasText: "Didn't know" });
  await expect(unknown).toContainText("Answer");
  await expect(unknown.getByLabel("Kind of mistake")).toHaveValue("concept-gap");
  await unknown.getByRole("button", { name: "Confirm" }).tap();
  await expect(unknown).toContainText("Confirmed");

  const wrong = rows.filter({ hasText: "Answered 0" });
  await wrong.getByLabel("Kind of mistake").selectOption("misread");
  await expect(wrong).toContainText("Suggested");
  await expect(phone.locator(".progress-counts")).toContainText("Concept gap");

  // Only one kind shown, when asked.
  await phone.getByLabel("Show").selectOption("misread");
  await expect(rows).toHaveCount(1);
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  const log = await (await phone.request.get("/api/mistakes")).json();
  const tags = (log as { mistakes: { confirmed: string | null }[] }).mistakes
    .map((m) => m.confirmed)
    .filter((tag) => tag !== null)
    .sort();
  expect(tags).toEqual(["concept-gap", "misread"]);
});

test("practises offline on a phone, keeping answers across a reload, and syncs them later", async () => {
  // The app is kept on the phone by its service worker, once that's in charge of the page.
  await phone.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await phone.reload();
  await expect
    .poll(() => phone.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await goHome();
  await expect(phone.locator(".track")).toHaveCount(6);

  await context.setOffline(true);
  // Opened afresh with no connection at all, the app still starts, from what the phone kept.
  await phone.goto("/practice/probability");
  await expect(phone.getByRole("heading", { name: "Probability" })).toBeVisible();
  await expect(phone.locator(".learn-sync")).toContainText("Offline");

  await answer(await answerShown());
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await expect(phone.locator(".learn-sync")).toHaveText("Offline · 1 to sync");

  await phone.reload();
  await expect(phone.locator(".learn-sync")).toHaveText("Offline · 1 to sync");
  await answer("0");
  await expect(phone.locator(".learn-sync")).toHaveText("Offline · 2 to sync");
  expect(await scheduled("probability")).toBe(0);

  await context.setOffline(false);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved", { timeout: 15_000 });
  expect(await scheduled("probability")).toBe(2);
});

test("sends an answer again when the reply was lost, without counting it twice", async ({
  browser,
}) => {
  // Without the service worker, which would keep the page's requests from the test.
  const other = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LEARNING_PORT}`,
    serviceWorkers: "block",
  });
  const page = await other.newPage();
  await page.goto(`/practice/probability?token=${token()}`);
  await expect(page.locator(".learn-sync")).toHaveText("Saved");
  // The server gets the first sync, but its reply never arrives, as on a dropping connection.
  const syncs: string[] = [];
  await page.route("**/api/learning/sync*", async (route) => {
    if (syncs.push(route.request().postData() ?? "") > 1) return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });
  await answer(await answerShown(page), page);
  await expect(page.locator(".learn-sync")).toContainText("Offline");
  // Tried again, it's taken once.
  await expect(page.locator(".learn-sync")).toHaveText("Saved", { timeout: 20_000 });
  expect(syncs.length).toBeGreaterThan(1);
  expect(syncs[1]).toBe(syncs[0]);
  await other.close();

  const deck = await serverDeck();
  const answered = Object.entries(deck.schedules).filter(([key]) =>
    deck.items.some((item) => item.key === key && item.kind === "probability"),
  );
  expect(answered).toHaveLength(3);
  expect(answered.every(([, schedule]) => schedule.reviews === 1)).toBe(true);
});

test("counts what was done towards the week, and offers more", async () => {
  await phone.goto("/");
  await expect(phone.locator(".week-label")).toContainText("minutes this week");
  // Every answer's in, so nothing's waiting on this phone.
  await expect(phone.locator(".home-pending")).toHaveCount(0);
  await expect(phone.locator(".track", { hasText: "Probability" })).toContainText("7 new");
});
