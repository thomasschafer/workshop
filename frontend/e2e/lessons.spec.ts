import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import { LESSONS_HOME, LESSONS_PORT } from "./fixture";
import { setOffline } from "./offline";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;

const token = () => readFileSync(join(LESSONS_HOME, "config", "token"), "utf8").trim();

interface ServerDeck {
  items: { key: string; track: string; prompt: string; lesson?: string | null }[];
  schedules: Record<string, unknown>;
  flags: Record<string, unknown>;
  retirements: Record<string, unknown>;
  follow_ups?: string[];
  lesson_completions: Record<string, number[]>;
  lesson_skips: Record<string, number[]>;
  limits: { daily_new?: number; daily_lessons?: number };
  progress: { lessons_today: number; minutes_this_week: number };
}

async function serverDeck(): Promise<ServerDeck> {
  const response = await phone.request.get("/api/learning/deck?utc_offset=0");
  expect(response.ok()).toBe(true);
  return (await response.json()) as ServerDeck;
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LESSONS_PORT}`,
  });
  phone = await context.newPage();
  await phone.goto(`/?token=${token()}`);
});

test.afterAll(async () => {
  await context?.close();
});

function lessonRow(title: string) {
  return phone
    .getByRole("region", { name: "Lessons" })
    .locator(".lesson-item")
    .filter({ has: phone.locator(".lesson-item-name", { hasText: title }) });
}

test("Continue goes to a track's next lesson and home lines mention lessons waiting", async () => {
  // Home lines mention a lesson waiting alongside due and new counts, leaving out items waiting
  // for their lesson (Review has 9 unlocked cards, leaving out binary-heap-costs).
  await expect(phone.locator(".track", { hasText: "Review" })).toContainText("1 lesson · 9 new");
  await expect(phone.locator(".track", { hasText: "Coding" })).toContainText("1 lesson");
  await expect(phone.locator(".track", { hasText: "Notes" })).toContainText("1 lesson · 1 new");

  // Where Continue would go to Coding's new items, it goes to Coding's next lesson first,
  // naming it and saying it's a lesson.
  const next = phone.locator(".continue");
  await expect(next).toContainText("How call stacks work");
  await expect(next).toContainText("Coding · Lesson");
  await next.tap();
  await expect(phone).toHaveURL(/\/lessons\/study\/stack-frames$/);
  await expect(phone.getByRole("heading", { name: "How call stacks work" })).toBeVisible();

  await phone.getByRole("banner").getByRole("button", { name: "Home" }).tap();
  await expect(phone).toHaveURL(/\/$/);
});

test("offers the sample lesson in the flow, completes it with guesses, SVG, checks, reload resume, grader mark and recap, and carries on", async () => {
  await phone.locator(".track", { hasText: "Review" }).tap();
  await expect(phone).toHaveURL(/\/practice\/review$/);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");

  // The track's next lesson is offered as a short card in the practice flow before new items.
  const flowCard = phone.locator(".lesson-flow-card");
  await expect(flowCard).toBeVisible();
  await expect(flowCard.locator(".lesson-meta")).toHaveText("Lesson · ~4 min");
  await expect(flowCard.getByRole("heading", { name: "How a binary heap works" })).toBeVisible();
  await expect(flowCard.getByRole("button", { name: "Not now" })).toBeVisible();
  await flowCard.getByRole("button", { name: "Start" }).tap();

  // Starting from the flow opens the lesson screen straight into Guess 1 of 2.
  await expect(phone).toHaveURL(/\/lessons\/sample\/binary-heaps$/);
  await expect(phone.locator(".lesson-step-label")).toContainText("Guess 1 of 2");
  await phone.getByRole("button", { name: "At index 1 or index 2" }).tap();
  await expect(phone.locator(".learn-verdict")).toHaveCount(0);

  // Guess 2: choose "Not sure"; moves straight to segment 1.
  await expect(phone.locator(".lesson-step-label")).toContainText("Guess 2 of 2");
  await phone.getByRole("button", { name: "Not sure" }).tap();

  // Segment 1: inline SVG takes the theme's text colour via currentColor and fits viewport width.
  await expect(phone.locator(".lesson-progress-label")).toHaveText("Segment 1 of 3");
  await expect(
    phone.getByRole("heading", { name: "The heap property and array layout" }),
  ).toBeVisible();
  const svg = phone.locator(".lesson-figure svg");
  await expect(svg).toBeVisible();
  await expect(svg).toHaveAttribute("role", "img");
  await expect(svg).toHaveAttribute("aria-label", /binary min-heap/);

  for (const colorScheme of ["light", "dark"] as const) {
    await phone.emulateMedia({ colorScheme });
    const { svgColor, textColor } = await svg.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--fg)";
      document.body.append(probe);
      const textColor = getComputedStyle(probe).color;
      probe.remove();
      return { svgColor: getComputedStyle(el).color, textColor };
    });
    expect(svgColor).toBe(textColor);
  }
  await phone.emulateMedia({ colorScheme: null });

  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

  // Answer segment 1's check, see verdict + explanation, continue to segment 2.
  await expect(phone.getByRole("button", { name: "Continue" })).toHaveCount(0);
  await phone.getByRole("button", { name: "Indices 7 and 8" }).tap();
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await expect(phone.locator(".learn-answer")).toContainText("2i + 1 and 2i + 2");
  await phone.getByRole("button", { name: "Continue" }).tap();

  // Segment 2: reload part-way and verify progress resumes here.
  await expect(phone.locator(".lesson-progress-label")).toHaveText("Segment 2 of 3");
  await expect(phone.getByRole("heading", { name: "Adding and removing" })).toBeVisible();
  await phone.reload();
  await expect(phone.locator(".lesson-progress-label")).toHaveText("Segment 2 of 3");
  await expect(phone.getByRole("heading", { name: "Adding and removing" })).toBeVisible();

  // Go back to segment 1, confirm earlier check stays answered, then return to segment 2.
  await phone.getByRole("button", { name: "Previous" }).tap();
  await expect(phone.locator(".lesson-progress-label")).toHaveText("Segment 1 of 3");
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await phone.getByRole("button", { name: "Continue" }).tap();
  await expect(phone.locator(".lesson-progress-label")).toHaveText("Segment 2 of 3");

  // Answer segment 2's check wrong, see the right answer and explanation, continue to segment 3.
  await phone.getByRole("button", { name: "The larger child is always a leaf" }).tap();
  await expect(phone.locator(".learn-verdict")).toContainText("Swapping with the larger child");
  await expect(phone.locator(".learn-answer")).toContainText("no larger than either child");
  await phone.getByRole("button", { name: "Continue" }).tap();

  // Segment 3 has no check, so Continue is shown straight away.
  await expect(phone.locator(".lesson-progress-label")).toHaveText("Segment 3 of 3");
  await expect(phone.getByRole("heading", { name: "Building a heap in O(n)" })).toBeVisible();
  await phone.getByRole("button", { name: "Continue" }).tap();

  // Explain step: answer in own words and have the stand-in grader mark it.
  await expect(phone.locator(".lesson-step-label")).toHaveText("Explain in your own words");
  await phone
    .getByLabel("Your explanation")
    .fill(
      "A binary heap is a complete binary tree so indices avoid pointers and its height stays O(log n).",
    );
  await phone.getByRole("button", { name: "Mark my explanation" }).tap();
  await expect(phone.locator(".marked-score")).toHaveText("90%");
  await expect(phone.getByRole("region", { name: "Explain answer" })).toContainText(
    "complete binary tree filled level by level",
  );
  // Lessons do not log mistakes or feed scheduling.
  const mistakes = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: unknown[];
  };
  expect(mistakes.mistakes).toEqual([]);
  expect((await serverDeck()).schedules["sample/binary-heaps"]).toBeUndefined();

  // Recap: shows each guess alongside the right answer and "Read more" links.
  await phone.getByRole("button", { name: "Continue" }).tap();
  await expect(phone.getByRole("heading", { name: "Recap" })).toBeVisible();
  const guessItems = phone.locator(".lesson-recap-guess");
  await expect(guessItems).toHaveCount(2);
  await expect(guessItems.nth(0)).toContainText("Your guess: At index 1 or index 2");
  await expect(guessItems.nth(0)).toContainText("Right answer: At index 1 or index 2");
  await expect(guessItems.nth(1)).toContainText("Your guess: Not sure");
  await expect(guessItems.nth(1)).toContainText("Right answer: O(n)");
  const readMoreLink = phone
    .getByRole("region", { name: "Read more" })
    .getByRole("link", { name: "Python's heapq module documentation" });
  await expect(readMoreLink).toHaveAttribute("target", "_blank");
  await expect(readMoreLink).toHaveAttribute(
    "href",
    "https://docs.python.org/3/library/heapq.html",
  );

  // Done returns to Review's practice flow, which carries straight on to the new card (not the
  // lesson's linked card, which waits until tomorrow).
  await phone.getByRole("button", { name: "Done" }).tap();
  await expect(phone).toHaveURL(/\/practice\/review$/);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  await expect(phone.locator(".lesson-flow-card")).toHaveCount(0);
  await expect(phone.locator(".learn-prompt")).not.toContainText("binary heap");

  // With daily_new = 1, finishing the one card for today lands on Done + the Lessons list.
  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "Good" }).tap();
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");

  const lessons = phone.getByRole("region", { name: "Lessons" });
  await expect(lessons).toBeVisible();
  await expect(lessonRow("How a binary heap works")).toContainText("Done · ~4 min");
  const deck = await serverDeck();
  expect(deck.lesson_completions["sample/binary-heaps"]).toHaveLength(1);
  expect(deck.progress.lessons_today).toBe(1);
});

test("Not now skips a lesson for the rest of the day and carries on with the track's items", async () => {
  // Notes is a kept-apart track, so it still has its own daily_lessons = 1 even though Review's
  // lesson was just completed.
  await phone.getByRole("banner").getByRole("button", { name: "Home" }).tap();
  await expect(phone).toHaveURL(/\/$/);
  await phone.locator(".track", { hasText: "Notes" }).tap();
  await expect(phone).toHaveURL(/\/practice\/pack%3Anotes$/);

  const flowCard = phone.locator(".lesson-flow-card");
  await expect(flowCard).toBeVisible();
  await expect(flowCard.getByRole("heading", { name: "How hash tables probe" })).toBeVisible();
  await flowCard.getByRole("button", { name: "Not now" }).tap();

  // Skips the lesson and carries straight on to the unlocked card (while notes-linked waits).
  await expect(phone.locator(".lesson-flow-card")).toHaveCount(0);
  await expect(phone.locator(".learn-prompt")).toContainText("load factor range");
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");

  // Reloading the track does not re-offer the skipped lesson for the rest of the day.
  await phone.reload();
  await expect(phone.locator(".lesson-flow-card")).toHaveCount(0);
  await expect(phone.locator(".learn-prompt")).toContainText("load factor range");

  // Home no longer mentions a lesson waiting in Notes.
  await phone.getByRole("banner").getByRole("button", { name: "Home" }).tap();
  await expect(phone).toHaveURL(/\/$/);
  const notes = phone.locator(".track", { hasText: "Notes" });
  await expect(notes).toContainText("1 new");
  await expect(notes).not.toContainText("lesson");
  expect((await serverDeck()).lesson_skips["study/notes-lesson"]).toHaveLength(1);
});

test("opens a lesson with unmet prerequisites, completes a lesson offline by comparing, and syncs when back online", async () => {
  // With today's shared daily_new and daily_lessons spent, Mental maths lands straight on its
  // Lessons list.
  await phone.locator(".track", { hasText: "Mental maths" }).tap();
  await expect(phone).toHaveURL(/\/practice\/mental-maths$/);
  await expect(phone.getByRole("region", { name: "Lessons" })).toBeVisible();
  await expect(lessonRow("Contiguous memory in arrays")).toContainText("Not done · ~2 min");
  await expect(lessonRow("Resizing a dynamic array")).toContainText(
    "Not done · ~3 min · Do first: Contiguous memory in arrays",
  );

  // A lesson whose prerequisite isn't done yet can still be opened.
  await lessonRow("Resizing a dynamic array").tap();
  await expect(phone).toHaveURL(/\/lessons\/study\/arrays-growth$/);
  await expect(phone.locator(".lesson-requires-note")).toContainText("Contiguous memory in arrays");
  await phone.getByRole("banner").getByRole("button", { name: "Mental maths" }).tap();
  await expect(phone).toHaveURL(/\/practice\/mental-maths$/);

  // Go offline, complete a lesson with no guesses and a PNG diagram by comparing with the answer.
  await setOffline(context, true);
  await lessonRow("Contiguous memory in arrays").tap();
  await expect(phone).toHaveURL(/\/lessons\/study\/arrays-intro$/);
  await phone.getByRole("button", { name: "Start" }).tap();

  // No guesses -> skips straight to segment 1, with embedded PNG rendered offline.
  await expect(phone.locator(".lesson-progress-label")).toHaveText("Segment 1 of 1");
  const png = phone.locator(".lesson-figure img");
  await expect(png).toBeVisible();
  await expect(png).toHaveAttribute("alt", "A small diagram of contiguous memory cells");
  await expect(png).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(await png.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

  await phone.getByRole("button", { name: "Continue" }).tap();
  await expect(phone.locator(".lesson-step-label")).toHaveText("Explain in your own words");
  await phone
    .getByLabel("Your explanation")
    .fill("Elements are contiguous so the address is base plus index times size.");
  await phone.getByRole("button", { name: "Compare with answer" }).tap();
  await expect(phone.getByRole("region", { name: "Your explanation" })).toContainText(
    "base plus index times size",
  );
  await expect(phone.getByRole("region", { name: "Explain answer" })).toContainText(
    "stored contiguously",
  );

  await phone.getByRole("button", { name: "Continue" }).tap();
  await expect(phone.getByRole("heading", { name: "Recap" })).toBeVisible();
  await phone.getByRole("button", { name: "Done" }).tap();
  await expect(phone).toHaveURL(/\/practice\/mental-maths$/);

  // Offline status reflects pending completion, and local list updates immediately.
  await expect(phone.locator(".learn-sync")).toContainText("Offline · 1 to sync");
  await expect(lessonRow("Contiguous memory in arrays")).toContainText("Done · ~2 min");
  await expect(lessonRow("Resizing a dynamic array")).not.toContainText("Do first:");

  // Back online: syncs completion to the server.
  await setOffline(context, false);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  expect((await serverDeck()).lesson_completions["study/arrays-intro"]).toHaveLength(1);
});

test("holds a lesson's item until the next day, offers Teach me for its segment, and offers Revisit the lesson after two lapses", async ({
  browser,
}) => {
  // Fresh context without the service worker so we can move Date.now() to the next day and check
  // offline scheduling, Teach me, and Revisit the lesson against the completed binary-heaps lesson.
  const other = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LESSONS_PORT}`,
    serviceWorkers: "block",
  });
  const page = await other.newPage();
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    let shift = 0;
    Date.now = () => realNow() + shift;
    Object.assign(window, {
      advanceMinutes: (minutes: number) => {
        shift += minutes * 60_000;
      },
    });
  });
  const advanceMinutes = (minutes: number) =>
    page.evaluate(
      (m) => (window as unknown as { advanceMinutes: (n: number) => void }).advanceMinutes(m),
      minutes,
    );

  // Start with a deck that has sample/binary-heaps completed today, daily_new = 10, no attempts
  // yet, and binary-heap-costs first among Review's cards (followed by another card to carry on
  // to after Teach me / Revisit).
  await page.route("**/api/learning/sync*", async (route) => {
    const response = await route.fetch();
    const deck = (await response.json()) as ServerDeck;
    deck.schedules = {};
    deck.flags = {};
    deck.retirements = {};
    deck.follow_ups = [];
    deck.limits.daily_new = 10;
    deck.limits.daily_lessons = 0;
    const reviewItems = deck.items.filter((i) => i.track === "review");
    const heapCard = reviewItems.find((i) => i.key === "sample/binary-heap-costs");
    const others = reviewItems.filter((i) => i.key !== "sample/binary-heap-costs").slice(0, 2);
    if (!heapCard) throw new Error("expected sample/binary-heap-costs in deck");
    deck.items = [heapCard, ...others];
    await route.fulfill({ response, json: deck });
  });

  await page.goto(`/?token=${token()}`);
  await expect(page.locator(".track", { hasText: "Review" })).toBeVisible();
  await page.locator(".track", { hasText: "Review" }).tap();
  await expect(page.locator(".learn-sync")).toHaveText("Saved");
  await page.unrouteAll({ behavior: "wait" });
  await setOffline(other, true);

  // Same day as completing binary-heaps: binary-heap-costs is held back, so one of the other
  // cards is shown instead, and Teach me is not shown on an unlinked card.
  await expect(page.locator(".learn-prompt")).not.toContainText("binary heap");
  await expect(page.getByRole("button", { name: "Teach me" })).toHaveCount(0);

  // Move the clock into the learner's next day (25 hours forward) and re-enter Review.
  await advanceMinutes(25 * 60);
  await page.getByRole("banner").getByRole("button", { name: "Home" }).tap();
  await page.locator(".track", { hasText: "Review" }).tap();

  // Now binary-heap-costs is unlocked and offered first, with "Teach me" alongside its other
  // ways to answer.
  await expect(page.locator(".learn-prompt")).toContainText("binary heap");
  await expect(page.getByRole("button", { name: "Teach me" })).toBeVisible();
  await page.getByRole("button", { name: "Teach me" }).tap();

  // Because sample/binary-heaps has already been done and binary-heap-costs names segment 2,
  // Teach me opens just segment 2 with its check (no opening or guesses).
  await expect(page).toHaveURL(/\/lessons\/sample\/binary-heaps\?segment=2$/);
  await expect(page.locator(".lesson-step-label")).toHaveText(
    "How a binary heap works · Segment 2 of 3",
  );
  await expect(page.getByRole("heading", { name: "Adding and removing" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Done" })).toHaveCount(0);
  await page.getByRole("button", { name: /Swapping with the larger child/ }).tap();
  await expect(page.locator(".learn-verdict")).toHaveText("Right");
  await page.getByRole("button", { name: "Done" }).tap();

  // Returns to the flow and carries on with the next card, without adding a lesson completion.
  await expect(page).toHaveURL(/\/practice\/review$/);
  await expect(page.locator(".learn-count")).toContainText("1 done");
  await expect(page.locator(".learn-prompt")).not.toContainText("binary heap");
  const pendingCompletions = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("workshop:learning") ?? "{}") as {
      lesson_completions?: unknown[];
      attempts?: { item: string; rating: string }[];
    };
    return {
      completions: saved.lesson_completions?.length ?? 0,
      heapAttempts: (saved.attempts ?? []).filter((a) => a.item === "sample/binary-heap-costs"),
    };
  });
  expect(pendingCompletions.completions).toBe(0);
  expect(pendingCompletions.heapAttempts).toHaveLength(1);
  expect(pendingCompletions.heapAttempts[0]?.rating).toBe("again");

  // Move the clock past the 10-minute minimum interval so binary-heap-costs is due again, then
  // rate it Forgot a second time running -> answer screen offers "Revisit the lesson" beside Next.
  await advanceMinutes(11);
  await page.getByRole("banner").getByRole("button", { name: "Home" }).tap();
  await page.locator(".track", { hasText: "Review" }).tap();
  await expect(page.locator(".learn-prompt")).toContainText("binary heap");
  await page.getByRole("button", { name: "Show answer" }).tap();
  await page.getByRole("button", { name: "Forgot" }).tap();

  const nextBtn = page.getByRole("button", { name: "Next" });
  const revisitBtn = page.getByRole("button", { name: "Revisit the lesson" });
  await expect(nextBtn).toBeVisible();
  await expect(revisitBtn).toBeVisible();
  const width = page.viewportSize()?.width ?? 0;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

  // Tapping "Revisit the lesson" opens segment 2, then returns to the flow on the next card.
  await revisitBtn.tap();
  await expect(page).toHaveURL(/\/lessons\/sample\/binary-heaps\?segment=2$/);
  await expect(page.getByRole("heading", { name: "Adding and removing" })).toBeVisible();
  await page.getByRole("button", { name: /Swapping with the larger child/ }).tap();
  await page.getByRole("button", { name: "Done" }).tap();

  await expect(page).toHaveURL(/\/practice\/review$/);
  await expect(page.locator(".learn-count")).toContainText("1 done");
  await expect(page.locator(".learn-prompt")).not.toContainText("binary heap");

  await other.close();
});
