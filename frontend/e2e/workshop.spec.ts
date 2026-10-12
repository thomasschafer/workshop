import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { HOME, PORT } from "./fixture";

// The tests share one page and run in order, like one session with the app.
test.describe.configure({ mode: "serial" });

let page: Page;
const solution = join(HOME, "solutions", "2017", "day04", "main.py");

/** Says something, by typing it in place of speech, and waits for the reply. */
async function say(text: string): Promise<void> {
  await page.locator(".typed input").fill(text);
  await page.locator(".typed input").press("Enter");
  await expect(page.locator(".feedback")).not.toContainText("Editing…", { timeout: 15_000 });
}

const editor = () => page.locator(".cm-content");

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ baseURL: `http://127.0.0.1:${PORT}` });
  const token = readFileSync(join(HOME, "config", "token"), "utf8").trim();
  await page.goto(`/?token=${token}`);
});

test.afterAll(async () => {
  await page?.close();
});

test("opens a puzzle from the picker", async () => {
  await page.getByRole("button", { name: "2017" }).click();
  await page.locator(".day", { hasText: /^4$/ }).click();
  await expect(page.locator(".problem")).toContainText("Day 4: Counting Lines");
  await expect(page.locator(".sample-summary")).toContainText(
    "Part 1 sample: code block 1 · expects 3",
  );
});

test("edits by voice, and undoes without the model", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await say("return the number of lines");
  await expect(page.locator(".feedback")).toContainText("returned the number of lines");
  await expect(editor()).toContainText("return len(data.splitlines())");

  await say("undo");
  await expect(editor()).not.toContainText("return len(data.splitlines())");
  await say("redo");
  await expect(editor()).toContainText("return len(data.splitlines())");
});

test("replies to the model's question", async () => {
  await say("change it");
  await expect(page.locator(".feedback")).toContainText("part 1 or part 2");
  await page.getByRole("button", { name: "Reply" }).click();
  await expect(page.locator(".talk")).toHaveText("Hold to reply");
  await say("part two, make it return zero");
  await expect(editor()).toContainText("return 0");
  await expect(page.locator(".talk")).toHaveText("Hold to talk");
});

test("runs on the sample and the real input", async () => {
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Run sample" }).click();
  await expect(page.locator(".run-result")).toContainText("Part 1: 3 ✓");
  await page.getByRole("button", { name: "Run real input" }).click();
  await expect(page.locator(".run-result")).toContainText("Part 1: 5");
  await page.getByRole("button", { name: "Close" }).click();
});

test("discusses the puzzle, keeping the conversation", async () => {
  await page.getByRole("button", { name: "Discuss", exact: true }).click();
  await say("why is part one wrong");
  await expect(page.locator(".turn.coach")).toHaveText(
    'You asked "why is part one wrong", after 1 question(s).',
  );
  await say("and part two");
  await expect(page.locator(".turn.coach").last()).toHaveText(
    'You asked "and part two", after 2 question(s).',
  );
});

test("keeps everything across a reload", async () => {
  await expect.poll(() => readFileSync(solution, "utf8")).toContain("return 0");
  await page.reload();
  await expect(page.locator(".puzzle-button")).toContainText("2017 · day 4");
  await expect(page.locator(".turn")).toHaveCount(4);
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.locator(".turn")).toHaveCount(0);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(editor()).toContainText("return len(data.splitlines())");
});

test("shows help as a modal", async () => {
  await page.getByRole("button", { name: "Help" }).click();
  await expect(page.getByRole("dialog", { name: "How Workshop works" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
