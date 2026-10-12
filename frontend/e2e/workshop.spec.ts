import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { HOME, PORT } from "./fixture";

// The tests share one page and run in order, like one session with the app.
test.describe.configure({ mode: "serial" });

let page: Page;
const solution = join(HOME, "solutions", "2017", "day04", "main.py");
const uiState = join(HOME, "data", "state.json");

/** Says something, by typing it in place of speech, and waits for the reply. */
async function say(text: string): Promise<void> {
  await page.locator(".typed input").fill(text);
  await page.locator(".typed input").press("Enter");
  await expect(page.locator(".talk.working")).toHaveCount(0, { timeout: 15_000 });
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
  await expect(page.locator(".picker")).toContainText("5 stars in 2017");
  await page.locator(".day", { hasText: /^4$/ }).click();
  await expect(page.locator(".problem")).toContainText("Day 4: Counting Lines");
  await expect(page.locator(".sample-summary")).toContainText(
    "Part 1 sample: code block 1 · expects 3",
  );
  // The first solution comes with helpers to share, and settings for the language server.
  expect(readFileSync(join(HOME, "solutions", "lib", "aoc.py"), "utf8")).toContain("def ints(");
  expect(readFileSync(join(HOME, "solutions", "pyrightconfig.json"), "utf8")).toContain("lib");
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

test("runs what was said, even when run before the edit is made", async () => {
  await page.locator(".typed input").fill("slowly make it return seven");
  await page.locator(".typed input").press("Enter");
  // The button shows the edit is under way, and for how long.
  await expect(page.locator(".talk")).toHaveText(/^Editing… \d+\.\ds$/);
  await expect(page.locator(".talk")).toHaveText(/Editing… (0\.[5-9]|[1-9]\.\d)s/);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Run sample" }).click();
  await expect(page.locator(".run-result")).toContainText("Part 1: 7");
  await page.getByRole("button", { name: "Close" }).click();
  await say("undo");
  await expect(editor()).toContainText("return len(data.splitlines())");
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
  await expect.poll(() => readFileSync(uiState, "utf8")).toMatch(/"tab": *"discuss"/);
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

test("closes settings when going back, staying in the app", async () => {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".puzzle-button")).toContainText("2017 · day 4");

  // Closed with its button, it leaves no history entry behind to go back through.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog").locator(".sheet-header").getByRole("button").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Help" }).click();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".puzzle-button")).toContainText("2017 · day 4");
});

test("wraps long lines only when chosen", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(editor()).not.toHaveClass(/cm-lineWrapping/);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Wrap long lines of code").check();
  await page.keyboard.press("Escape");
  await expect(editor()).toHaveClass(/cm-lineWrapping/);
  await page.reload();
  await expect(editor()).toHaveClass(/cm-lineWrapping/);
});

test("offers to install a missing package, and uses it", async () => {
  await say("use the lanterns package");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Run sample" }).click();
  await expect(page.locator(".run-result")).toContainText("No module named 'lanterns'");
  await page.getByRole("button", { name: "Close" }).click();

  await expect(page.locator(".banner")).toContainText("lanterns isn't installed.");
  await page.getByRole("button", { name: "Install lanterns" }).click();
  await expect(page.locator(".feedback")).toContainText("Installed lanterns");
  await expect(page.locator(".banner")).toHaveCount(0);
  expect(readFileSync(join(HOME, "solutions", "python-packages.txt"), "utf8")).toMatch(
    /^lanterns$/m,
  );

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Run sample" }).click();
  await expect(page.locator(".run-result")).toContainText("Part 1: 3 ✓");
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".packages")).toContainText("lanterns");
  await expect(page.locator(".packages")).toContainText("Installed.");
  await page.keyboard.press("Escape");
});

test("installs what's listed after the list is edited elsewhere", async () => {
  const manifest = join(HOME, "solutions", "python-packages.txt");
  writeFileSync(manifest, `${readFileSync(manifest, "utf8")}lanterns_extra\n`);
  await page.reload();
  await expect(page.locator(".banner")).toContainText("changed since the packages were installed");
  await page.locator(".banner").getByRole("button", { name: "Install" }).click();
  await expect(page.locator(".banner")).toHaveCount(0);

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".packages")).toContainText("lanterns_extra");
  await page.getByRole("button", { name: "Remove lanterns_extra" }).click();
  await expect(page.locator(".packages")).not.toContainText("lanterns_extra");
  await expect(page.locator(".packages")).toContainText("Installed.");
  expect(readFileSync(manifest, "utf8")).not.toContain("lanterns_extra");
  await page.keyboard.press("Escape");
});

test("plays the practice puzzle through, with no Advent of Code login needed", async () => {
  const dir = join(HOME, "solutions", "practice", "day01");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "main.py"),
    `import sys

from aoc import ints


def sleds(data: str) -> list[list[int]]:
    return [ints(line) for line in data.splitlines()]


def part1(data: str) -> int:
    return sum(1 for s in sleds(data) if sum(s) > 100)


def part2(data: str) -> int:
    return sum(max(s) for s in sleds(data) if sum(s) <= 100)


if __name__ == "__main__":
    data = sys.stdin.read()
    print(part1(data))
    print(part2(data))
`,
  );
  await page.locator(".puzzle-button").click();
  await page.getByRole("button", { name: "Practice puzzle" }).click();
  await expect(page.locator(".puzzle-button")).toContainText("Practice puzzle");
  await expect(page.locator(".problem")).toContainText("Practice: Sled Parcels");
  await expect(page.locator(".sample-summary")).toContainText("expects 2");

  for (const part of [1, 2]) {
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByRole("button", { name: "Run sample" }).click();
    await expect(page.locator(".run-result")).toContainText(
      `Part ${part}: ${part === 1 ? 2 : 45} ✓`,
    );
    await page.getByRole("button", { name: "Run real input" }).click();
    await page.getByRole("button", { name: new RegExp(`^Submit part ${part}: \\d+$`) }).click();
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.locator(".submitted").first()).toContainText("Correct!");
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.locator(".top")).toContainText("★".repeat(part));
  }

  await page.getByRole("button", { name: "Problem", exact: true }).click();
  await expect(page.locator(".problem")).toContainText("Part Two");
  await page.getByRole("button", { name: "Start again" }).click();
  await expect(page.locator(".problem")).not.toContainText("Part Two");
});
