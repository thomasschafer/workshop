import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import { SKIP_HOME, SKIP_PORT } from "./fixture";
import { setOffline } from "./offline";

// Each test has a lesson in a track of its own (see createSkipHome), whose checks' right answers
// are "Right 1", "Right 2" and so on, and whose explanation the stand-in grader marks 90% when it
// mentions the tree being complete or its height, and 60% otherwise.

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;

const token = () => readFileSync(join(SKIP_HOME, "config", "token"), "utf8").trim();

const GOOD_EXPLANATION = "The tree stays complete, so its height grows with log n.";

interface ServerDeck {
  items: { key: string }[];
  lesson_completions: Record<string, number[]>;
  lesson_skips: Record<string, number[]>;
}

async function serverDeck(): Promise<ServerDeck> {
  const response = await phone.request.get("/api/learning/deck?utc_offset=0");
  expect(response.ok()).toBe(true);
  return (await response.json()) as ServerDeck;
}

async function expectNoMistakes() {
  const mistakes = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: unknown[];
  };
  expect(mistakes.mistakes).toEqual([]);
}

/** Opens a track's practice flow, synced with the server. */
async function practise(track: string) {
  await phone.goto(`/practice/pack%3A${track}`);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
}

/** Answers the check being asked with `choice`, and moves on from it. */
async function answerCheck(choice: string, verdict: "Right" | "Not right") {
  await phone.getByRole("button", { name: choice, exact: true }).tap();
  await expect(phone.locator(".lesson-know-verdict")).toHaveText(verdict);
  // Answering says only whether it was right: the explanation waits until the end.
  await expect(phone.getByRole("region", { name: "Explanation" })).toHaveCount(0);
  await expect(phone.getByText(/^Explanation for part/)).toHaveCount(0);
  await phone.getByRole("button", { name: "Continue" }).tap();
}

function lessonRow(title: string) {
  return phone
    .getByRole("region", { name: "Lessons" })
    .locator(".lesson-item")
    .filter({ has: phone.locator(".lesson-item-name", { hasText: title }) });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${SKIP_PORT}`,
  });
  phone = await context.newPage();
  await phone.goto(`/?token=${token()}`);
});

test.afterAll(async () => {
  await context?.close();
});

test("passing I know this from the flow's lesson card counts the lesson done and holds its items until the next day", async ({
  browser,
}) => {
  await practise("passing");
  const flowCard = phone.locator(".lesson-flow-card");
  await expect(flowCard.getByRole("heading", { name: "Merging sorted runs" })).toBeVisible();
  await expect(flowCard.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(flowCard.getByRole("button", { name: "Not now" })).toBeVisible();
  await flowCard.getByRole("button", { name: "I know this" }).tap();

  // The checks come one at a time, with none of the segments' teaching before them.
  await expect(phone).toHaveURL(/\/lessons\/skim\/passing$/);
  await expect(phone.locator(".lesson-step-label")).toHaveText("I know this · Merging sorted runs");
  await expect(phone.getByRole("heading", { name: "Check 1 of 2" })).toBeVisible();
  await expect(phone.getByText(/teaching step/)).toHaveCount(0);
  await answerCheck("Right 1", "Right");
  await expect(phone.getByRole("heading", { name: "Check 2 of 2" })).toBeVisible();
  await answerCheck("Right 2", "Right");

  // Then the explain step, marked by the grader.
  await expect(phone.locator(".lesson-step-label")).toHaveText(
    "I know this · Explain in your own words",
  );
  await phone.getByLabel("Your explanation").fill(GOOD_EXPLANATION);
  await phone.getByRole("button", { name: "Mark my explanation" }).tap();

  // Passed: skipped, with the explain answer to compare with and the sources to read more.
  await expect(phone.getByRole("heading", { name: "You know this" })).toBeVisible();
  await expect(phone.getByRole("region", { name: "Your explanation, marked" })).toContainText(
    "90%",
  );
  await expect(phone.getByRole("region", { name: "Your explanation", exact: true })).toContainText(
    GOOD_EXPLANATION,
  );
  await expect(phone.getByRole("region", { name: "Explain answer" })).toContainText(
    "keeps its height logarithmic",
  );
  await expect(
    phone
      .getByRole("region", { name: "Read more" })
      .getByRole("link", { name: "Algorithms notes" }),
  ).toHaveAttribute("href", "https://example.com/passing");
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

  // Counted done as finishing the lesson is, and synced, without logging anything.
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  expect((await serverDeck()).lesson_completions["skim/passing"]).toHaveLength(1);
  await expectNoMistakes();

  // Done goes back to the flow, which carries on with the card that doesn't wait for the lesson;
  // the one that does is held until tomorrow, so once that's answered there's nothing left.
  await phone.getByRole("button", { name: "Done" }).tap();
  await expect(phone).toHaveURL(/\/practice\/pack%3Apassing$/);
  await expect(phone.locator(".lesson-flow-card")).toHaveCount(0);
  await expect(phone.locator(".learn-count")).toContainText("1 done");
  await expect(phone.locator(".learn-prompt")).toContainText("Is merge sort stable?");
  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "Good" }).tap();
  await expect(phone.getByRole("region", { name: "Lessons" })).toBeVisible();
  await expect(phone.locator(".learn-prompt")).toHaveCount(0);
  await expect(lessonRow("Merging sorted runs")).toContainText("Done · ~3 min");

  // On the learner's next day, the card that waited for the lesson is offered.
  const tomorrow = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${SKIP_PORT}`,
    serviceWorkers: "block",
  });
  const page = await tomorrow.newPage();
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 25 * 60 * 60_000;
  });
  // Leaving out the card answered today, which may be due again by then, ahead of it.
  await page.route("**/api/learning/sync*", async (route) => {
    const response = await route.fetch();
    const deck = (await response.json()) as ServerDeck;
    deck.items = deck.items.filter((item) => item.key !== "skim/passing-plain");
    await route.fulfill({ response, json: deck });
  });
  await page.goto(`/?token=${token()}`);
  await page.goto("/practice/pack%3Apassing");
  await expect(page.locator(".learn-sync")).toHaveText("Saved");
  await expect(page.locator(".learn-prompt")).toContainText("merging two sorted runs");
  await tomorrow.close();
});

test("not passing on a missed check shows what was missed, then starts the lesson at its segment", async () => {
  await practise("missing");
  await phone.locator(".lesson-flow-card").getByRole("button", { name: "I know this" }).tap();
  await answerCheck("Right 1", "Right");
  await answerCheck("Wrong 2", "Not right");

  // With a check missed, it goes straight to what was missed, without asking for an explanation.
  await expect(phone.getByRole("heading", { name: "Worth doing the lesson" })).toBeVisible();
  await expect(phone.getByLabel("Your explanation")).toHaveCount(0);
  const missed = phone.getByRole("region", { name: "A check you missed" });
  await expect(missed.locator("li")).toHaveCount(1);
  await expect(missed).toContainText("Check on part 2?");
  await expect(missed).toContainText("Your answer: Wrong 2");
  await expect(missed).toContainText("Right answer: Right 2");
  await expect(missed).toContainText("Explanation for part 2.");
  await expect(missed).not.toContainText("Check on part 1?");
  await expect(phone.getByRole("button", { name: "Not now" })).toBeVisible();

  // Not passing doesn't count the lesson done or log mistakes.
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  expect((await serverDeck()).lesson_completions["skim/missing"]).toBeUndefined();
  await expectNoMistakes();

  // The lesson starts at the segment whose check was missed, with that check to answer again.
  await phone.getByRole("button", { name: "Start the lesson" }).tap();
  await expect(phone.locator(".lesson-progress-label")).toHaveText("Segment 2 of 3");
  await expect(phone.getByRole("heading", { name: "Second part" })).toBeVisible();
  await expect(phone.getByText("teaching step 2")).toBeVisible();
  await expect(phone.getByRole("button", { name: "Continue" })).toHaveCount(0);
  await phone.getByRole("button", { name: "Right 2", exact: true }).tap();
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await expect(phone.locator(".learn-answer")).toContainText("Explanation for part 2.");

  // The segment before it can be gone back to, with its check answered right already.
  await phone.getByRole("button", { name: "Previous" }).tap();
  await expect(phone.locator(".lesson-progress-label")).toHaveText("Segment 1 of 3");
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
});

test("not passing on a poor explanation shows the grader's feedback, and Not now skips the lesson for the day", async () => {
  await practise("explaining");
  await phone.locator(".lesson-flow-card").getByRole("button", { name: "I know this" }).tap();
  await answerCheck("Right 1", "Right");
  await expect(phone.getByRole("heading", { name: "Check 2 of 2" })).toBeVisible();
  await answerCheck("Right 3", "Right");
  await phone.getByLabel("Your explanation").fill("It just works out.");
  await phone.getByRole("button", { name: "Mark my explanation" }).tap();

  await expect(phone.getByRole("heading", { name: "Worth doing the lesson" })).toBeVisible();
  await expect(phone.getByRole("region", { name: "A check you missed" })).toHaveCount(0);
  await expect(phone.getByRole("region", { name: "Checks you missed" })).toHaveCount(0);
  const mark = phone.getByRole("region", { name: "Your explanation, marked" });
  await expect(mark).toContainText("Your explanation: 60%");
  await expect(mark).toContainText("tie the complete tree shape");
  await expect(phone.getByRole("button", { name: "Start the lesson" })).toBeVisible();

  // Not now goes back to the flow, as on the lesson card, without counting the lesson done.
  await phone.getByRole("button", { name: "Not now" }).tap();
  await expect(phone).toHaveURL(/\/practice\/pack%3Aexplaining$/);
  await expect(phone.locator(".lesson-flow-card")).toHaveCount(0);
  await expect(lessonRow("Searching in depth")).toContainText("Not done");
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  const deck = await serverDeck();
  expect(deck.lesson_skips["skim/explaining"]).toHaveLength(1);
  expect(deck.lesson_completions["skim/explaining"]).toBeUndefined();
  await expectNoMistakes();

  // Skipped for the day, it isn't offered again on coming back.
  await practise("explaining");
  await expect(phone.locator(".lesson-flow-card")).toHaveCount(0);
});

test("offline, I know this says it can't be done and offers the lesson instead", async () => {
  await practise("offline");
  await setOffline(context, true);
  await phone.locator(".lesson-flow-card").getByRole("button", { name: "I know this" }).tap();
  await expect(phone).toHaveURL(/\/lessons\/skim\/offline$/);
  await expect(phone.getByRole("status").filter({ hasText: "You're offline" })).toContainText(
    "can't be done offline",
  );
  await expect(phone.getByRole("heading", { name: "Check 1 of 2" })).toHaveCount(0);
  await phone.getByRole("button", { name: "Do the lesson instead" }).tap();
  await expect(phone.locator(".lesson-progress-label")).toHaveText("Segment 1 of 3");
  await expect(phone.getByRole("heading", { name: "First part" })).toBeVisible();
  await setOffline(context, false);
});

test("a check opened from the list carries on where it was after a reload", async () => {
  // Not now on the flow's lesson card leaves the lesson in the track's list.
  await practise("resuming");
  await phone.locator(".lesson-flow-card").getByRole("button", { name: "Not now" }).tap();
  await lessonRow("Prefix trees").tap();
  await expect(phone).toHaveURL(/\/lessons\/skim\/resuming$/);
  await expect(phone.getByRole("button", { name: "Start" })).toBeVisible();
  await phone.getByRole("button", { name: "I know this" }).tap();

  await answerCheck("Right 1", "Right");
  await expect(phone.getByRole("heading", { name: "Check 2 of 2" })).toBeVisible();
  await phone.reload();
  await expect(phone.getByRole("heading", { name: "Check 2 of 2" })).toBeVisible();
  await answerCheck("Right 2", "Right");

  await phone.getByLabel("Your explanation").fill(GOOD_EXPLANATION);
  await phone.reload();
  await expect(phone.getByLabel("Your explanation")).toHaveValue(GOOD_EXPLANATION);
  await phone.getByRole("button", { name: "Mark my explanation" }).tap();
  await expect(phone.getByRole("heading", { name: "You know this" })).toBeVisible();

  // Reloaded, it goes back to the track itself once done.
  await phone.getByRole("button", { name: "Done" }).tap();
  await expect(phone).toHaveURL(/\/practice\/pack%3Aresuming$/);
  await expect(lessonRow("Prefix trees")).toContainText("Done · ~3 min");
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  expect((await serverDeck()).lesson_completions["skim/resuming"]).toHaveLength(1);
});

test("a lesson with only one check doesn't offer I know this", async () => {
  await practise("single");
  const flowCard = phone.locator(".lesson-flow-card");
  await expect(flowCard.getByRole("heading", { name: "Counting sort" })).toBeVisible();
  await expect(flowCard.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(flowCard.getByRole("button", { name: "I know this" })).toHaveCount(0);

  await flowCard.getByRole("button", { name: "Not now" }).tap();
  await lessonRow("Counting sort").tap();
  await expect(phone.getByRole("heading", { name: "Counting sort" })).toBeVisible();
  await expect(phone.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(phone.getByRole("button", { name: "I know this" })).toHaveCount(0);
});
