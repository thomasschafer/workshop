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
  schedules: Record<string, unknown>;
  lesson_completions: Record<string, number[]>;
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

test("walks through the sample lesson with guesses, inline themed SVG, checks, reload resume, grader mark and recap", async () => {
  await phone.locator(".track", { hasText: "Review" }).tap();
  await expect(phone).toHaveURL(/\/practice\/review$/);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");

  // With daily_new = 1, finishing the one card for today lands on the screen listing Lessons.
  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "Good" }).tap();
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");

  const lessons = phone.getByRole("region", { name: "Lessons" });
  await expect(lessons).toBeVisible();
  await expect(lessonRow("How a binary heap works")).toContainText("Not done · ~4 min");
  await expect(lessonRow("Resizing a dynamic array")).toContainText(
    "Not done · ~3 min · Do first: Contiguous memory in arrays",
  );

  // Open the sample lesson.
  await lessonRow("How a binary heap works").tap();
  await expect(phone).toHaveURL(/\/lessons\/sample\/binary-heaps$/);
  await expect(phone.getByRole("heading", { name: "How a binary heap works" })).toBeVisible();
  await expect(phone.locator(".lesson-meta")).toHaveText("~4 min");
  await phone.getByRole("button", { name: "Start" }).tap();

  // Guess 1: choose an answer; no feedback is shown, moves straight to guess 2.
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

  // Done returns to the track, where the lesson now shows Done and the server recorded it.
  await phone.getByRole("button", { name: "Done" }).tap();
  await expect(phone).toHaveURL(/\/practice\/review$/);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  await expect(lessonRow("How a binary heap works")).toContainText("Done · ~4 min");
  await expect(lessonRow("Contiguous memory in arrays")).toContainText("Not done · ~2 min");
  expect((await serverDeck()).lesson_completions["sample/binary-heaps"]).toHaveLength(1);
});

test("opens a lesson with unmet prerequisites, completes a lesson offline by comparing, and syncs when back online", async () => {
  // A lesson whose prerequisite isn't done yet can still be opened.
  await lessonRow("Resizing a dynamic array").tap();
  await expect(phone).toHaveURL(/\/lessons\/study\/arrays-growth$/);
  await expect(phone.locator(".lesson-requires-note")).toContainText("Contiguous memory in arrays");
  await phone.getByRole("banner").getByRole("button", { name: "Review" }).tap();
  await expect(phone).toHaveURL(/\/practice\/review$/);

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
  await expect(phone).toHaveURL(/\/practice\/review$/);

  // Offline status reflects pending completion, and local list updates immediately.
  await expect(phone.locator(".learn-sync")).toContainText("Offline · 1 to sync");
  await expect(lessonRow("Contiguous memory in arrays")).toContainText("Done · ~2 min");
  await expect(lessonRow("Resizing a dynamic array")).not.toContainText("Do first:");

  // Back online: syncs completion to the server.
  await setOffline(context, false);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  expect((await serverDeck()).lesson_completions["study/arrays-intro"]).toHaveLength(1);
});
