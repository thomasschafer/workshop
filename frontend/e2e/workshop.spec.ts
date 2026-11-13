import { createECDH, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { charFor, LAYOUT } from "../src/keyboard";
import { HOME, PORT } from "./fixture";
import { installSimulatedSpeech } from "./speech";

// The tests share one page and run in order, like one session with the app.
test.describe.configure({ mode: "serial" });

let page: Page;
const solution = join(HOME, "solutions", "2017", "day04", "main.py");
const uiState = join(HOME, "data", "state.json");

/** Says something, by typing it in place of speech, without waiting for what happens. */
async function send(text: string): Promise<void> {
  await page.locator(".typed input").fill(text);
  await page.locator(".typed input").press("Enter");
}

/** Says something and waits until its card shows what happened. */
async function say(text: string): Promise<void> {
  await send(text);
  await expect(page.locator(".card", { hasText: `“${text}”` }).last()).toHaveClass(
    /\b(done|asked|problem)\b/,
    { timeout: 15_000 },
  );
}

const card = (status: "waiting" | "working" | "done" | "asked" | "problem") =>
  page.locator(`.card.${status}`);

const editor = () => page.locator(".cm-content");

/** How long to wait for a run: a program's first start can be slow, such as on Windows. */
const RUN = { timeout: 20_000 };

/** Opens a page of settings, from the list of them. */
async function openSettings(title: string): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator(".settings-row", { hasText: title }).getByRole("button").click();
  await expect(page.getByRole("dialog", { name: title })).toBeVisible();
}

async function closeSettings(): Promise<void> {
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ baseURL: `http://127.0.0.1:${PORT}` });
  await page.addInitScript(installSimulatedSpeech, 20);
  // Counts cards animating in, to check one isn't replayed as words arrive.
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    const counts = { entrances: 0, moves: [] as string[] };
    Object.assign(window, { cardAnimations: counts });
    Element.prototype.animate = function (keyframes, options) {
      const first = Array.isArray(keyframes) ? keyframes[0] : undefined;
      if (this.classList.contains("card") && first?.opacity === 0) counts.entrances++;
      else if (this.classList.contains("card"))
        counts.moves.push(`${this.className} ${JSON.stringify(first)}`);
      return animate.call(this, keyframes, options);
    };
  });
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

test("keeps the puzzle scrolled where it was after looking at another tab", async () => {
  const phone = page.viewportSize();
  // Short enough that the puzzle scrolls.
  await page.setViewportSize({ width: phone?.width ?? 412, height: 400 });
  const problem = page.locator(".problem");
  await problem.evaluate((pane) => {
    pane.scrollTop = 60;
  });
  await expect.poll(() => problem.evaluate((pane) => pane.scrollTop)).toBe(60);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(problem).toBeHidden();
  await page.getByRole("button", { name: "Problem", exact: true }).click();
  await expect(problem).toBeVisible();
  expect(await problem.evaluate((pane) => pane.scrollTop)).toBe(60);
  if (phone) await page.setViewportSize(phone);
});

test("edits by voice, and undoes without the model", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await say("return the number of lines");
  await expect(card("done").last()).toContainText("returned the number of lines");
  await expect(editor()).toContainText("return len(data.splitlines())");

  await say("undo");
  await expect(editor()).not.toContainText("return len(data.splitlines())");
  await say("redo");
  await expect(editor()).toContainText("return len(data.splitlines())");
});

test("replies to the model's question", async () => {
  await say("change it");
  await expect(card("asked")).toContainText("part 1 or part 2");
  await page.getByRole("button", { name: "Reply" }).click();
  await expect(page.locator(".talk")).toHaveText("Hold to reply");
  await say("part two, make it return zero");
  await expect(editor()).toContainText("return 0");
  await expect(page.locator(".talk")).toHaveText("Hold to talk");
});

test("runs on the sample and the real input", async () => {
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Run sample" }).click();
  await expect(page.locator(".run-result")).toContainText("Part 1: 3 ✓", RUN);
  await page.getByRole("button", { name: "Run real input" }).click();
  await expect(page.locator(".run-result")).toContainText("Part 1: 5", RUN);
  await page.getByRole("button", { name: "Close" }).click();
});

test("warns when an answer is printed as a decimal", async () => {
  await say("divide it by one");
  await expect(editor()).toContainText("return len(data.splitlines()) / 1");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Run sample" }).click();
  await expect(page.locator(".run-result")).toContainText("Part 1: 3.0 ✗ (expected 3)", RUN);
  await expect(page.locator(".run-result .warning-text")).toContainText(
    "Part 1's answer, 3.0, looks like a decimal",
  );
  await page.getByRole("button", { name: "Close" }).click();
  await say("undo");
  await expect(editor()).not.toContainText("/ 1");
});

test("runs what was said, even when run before the edit is made", async () => {
  await send("slowly make it return seven");
  // Its card shows the edit is under way, and for how long, leaving the button free.
  await expect(card("working")).toContainText(/Editing · \d+\.\ds/);
  await expect(card("working")).toContainText(/Editing · (0\.[5-9]|[1-9]\.\d)s/);
  await expect(page.locator(".talk")).toHaveText("Hold to talk");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  // The Run panel is above everything, cards included.
  await expect(page.getByRole("dialog", { name: "Run" })).toBeVisible();
  const box = await card("working").boundingBox();
  if (!box) throw new Error("The working card isn't on screen.");
  const onTop = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.closest(".modal-backdrop") !== null,
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(onTop).toBe(true);
  await page.getByRole("button", { name: "Run sample" }).click();
  await expect(page.locator(".run-result")).toContainText("Part 1: 7", RUN);
  await page.getByRole("button", { name: "Close" }).click();
  await say("undo");
  await expect(editor()).toContainText("return len(data.splitlines())");
});

test("queues utterances as cards, and cancels them before or during their edit", async () => {
  await send("slowly make it return seven");
  await send("change it");
  await expect(card("working")).toContainText("slowly make it return seven");
  await expect(card("waiting")).toContainText("change it");

  // Cancelled while waiting, it never runs.
  await card("waiting").getByRole("button", { name: "Cancel" }).click();
  await expect(card("waiting")).toHaveCount(0);
  // Cancelled while being edited, the code is left alone.
  await card("working").getByRole("button", { name: "Cancel" }).click();
  await expect(card("working")).toHaveCount(0);
  // Past when the slow edit would have landed.
  await page.waitForTimeout(2000);
  await expect(editor()).toContainText("return len(data.splitlines())");
  await expect(card("asked")).toHaveCount(0);
});

test("discusses the puzzle, keeping the conversation", async () => {
  await page.getByRole("button", { name: "Discuss", exact: true }).click();
  await send("why is part one wrong");
  // The reply appears as it's written.
  await expect(page.locator(".turn.coach.writing")).toHaveText(
    'You asked "why is part one wrong", ',
  );
  await expect(page.locator(".turn.coach")).toHaveText(
    'You asked "why is part one wrong", after 1 question(s).',
  );
  await say("and part two");
  await expect(page.locator(".turn.coach").last()).toHaveText(
    'You asked "and part two", after 2 question(s).',
  );

  // Replies are formatted from markdown as they're written, with any HTML in them shown as text.
  await send("with some formatting please");
  await expect(page.locator(".turn.coach.writing strong")).toHaveText("clues");
  const formatted = page.locator(".turn.coach").last();
  await expect(formatted.locator("ol li")).toHaveCount(2);
  await expect(formatted.locator("code")).toHaveText("seen");
  await expect(formatted).toContainText("Try a <b>set</b>.");

  // A half-typed question is still there after looking at another tab.
  const input = page.getByPlaceholder("Or type a question");
  await input.fill("half a thought");
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: "Discuss", exact: true }).click();
  await expect(input).toHaveValue("half a thought");
  await input.fill("");
});

test("keeps everything across a reload", async () => {
  await expect.poll(() => readFileSync(solution, "utf8")).toContain("return 0");
  await expect.poll(() => readFileSync(uiState, "utf8")).toMatch(/"tab": *"discuss"/);
  await page.reload();
  await expect(page.locator(".puzzle-button")).toContainText("2017 · day 4");
  await expect(page.locator(".turn")).toHaveCount(6);
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

test("hides everything but the code and the keyboard in zen mode", async () => {
  const chromium = test.info().project.name === "chromium";
  // Which keys are kept for the page rather than the browser, which only Chromium can do.
  if (chromium) {
    await page.evaluate(() => {
      const keyboard = (
        navigator as Navigator & { keyboard: { lock(keys: string[]): Promise<void> } }
      ).keyboard;
      const lock = keyboard.lock.bind(keyboard);
      Object.assign(window, { lockedKeys: [] });
      keyboard.lock = (keys) => {
        (window as unknown as { lockedKeys: string[][] }).lockedKeys.push(keys);
        return lock(keys);
      };
    });
  }
  await page.getByRole("button", { name: "Problem", exact: true }).click();
  await page.getByRole("button", { name: "Zen mode" }).click();
  await expect(editor()).toBeVisible();
  await expect(editor()).toBeFocused();
  await expect(editor()).toHaveAttribute("inputmode", "text");
  for (const hidden of [".top", "nav.tabs", ".controls", ".status-line"]) {
    await expect(page.locator(hidden)).toBeHidden();
  }
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  // Escape is kept for Helix's keys, in browsers that can, rather than leaving full screen.
  if (chromium) {
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { lockedKeys: string[][] }).lockedKeys))
      .toEqual([["Escape"]]);
  }
  // Escape alone doesn't leave zen mode, wherever the browser takes it.
  await page.keyboard.press("Escape");
  await expect(page.locator(".top")).toBeHidden();

  await page.getByRole("button", { name: "Leave zen mode" }).click();
  await expect(page.locator(".puzzle-button")).toBeVisible();
  await expect(page.locator(".controls")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false);

  // Going back leaves zen mode too, staying in the app.
  await page.getByRole("button", { name: "Zen mode" }).click();
  await expect(page.locator(".top")).toBeHidden();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Leave zen mode" })).toHaveCount(0);
  await expect(page.locator(".puzzle-button")).toContainText("2017 · day 4");
  await expect(page.getByRole("button", { name: "Code", exact: true })).toHaveClass(/selected/);
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

test("offers to log in again when Advent of Code no longer accepts the cookie", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  // As the server answers once Advent of Code has turned the cookie away.
  await page.route("**/api/puzzles/*/*/run", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: "advent of Code didn't accept your session cookie; it may have expired.",
        action: "login",
      }),
    }),
  );
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Run real input" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  const offer = page.locator(".card", { hasText: "didn't accept your session cookie" });
  await expect(offer).toHaveCount(1);
  await page.unroute("**/api/puzzles/*/*/run");
  await offer.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("dialog", { name: "Set up Workshop" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
});

test("picks up code changed at the server while the app stays open", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(card("working")).toHaveCount(0);
  const before = readFileSync(solution, "utf8");
  // As if edited in an editor on the server, with the phone left open beside it.
  writeFileSync(solution, `# changed at the server\n${before}`);
  await expect(editor()).toContainText("# changed at the server", { timeout: 15_000 });
  await expect(page.locator(".banner", { hasText: "changed elsewhere" })).toHaveCount(0);
  writeFileSync(solution, before);
  await expect(editor()).not.toContainText("# changed at the server", { timeout: 15_000 });
});

test("opens a page of settings from the list, and goes back to the list", async () => {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".update-notice")).toContainText("Workshop 999.0.0 is out.");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await openSettings("Display");
  await expect(page.getByLabel("Wrap long lines of code")).toBeVisible();
  // Back from a page, by gesture, button or Escape, is the list; back again leaves settings.
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect(page.locator(".settings-row", { hasText: "Talking" })).toBeVisible();
  await page.locator(".settings-row", { hasText: "Models" }).getByRole("button").click();
  await page.getByRole("dialog").getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.locator(".settings-row", { hasText: "Talking" }).getByRole("button").click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".puzzle-button")).toContainText("2017 · day 4");
});

test("finds an example the puzzle writes inline, rather than in a code block", async () => {
  // Invented, in the style of older puzzles.
  const cached = join(HOME, "cache", "aoc", "2017", "05");
  mkdirSync(cached, { recursive: true });
  writeFileSync(
    join(cached, "problem.html"),
    `<html><body><main><article class="day-desc"><h2>--- Day 5: Dials ---</h2>
<p>For example, if the turns are <code>+2, -5, +4</code>, the dial ends at <code>1</code>.</p>
</article></main></body></html>`,
  );
  writeFileSync(join(cached, "input.txt"), "+1\n-1\n");
  await page.locator(".puzzle-button").click();
  await page.getByRole("button", { name: "2017", exact: true }).click();
  await page.locator(".day", { hasText: /^5$/ }).click();
  await page.getByRole("button", { name: "Problem", exact: true }).click();
  await expect(page.locator(".sample-summary")).toContainText("Part 1 sample: 3 lines · expects 1");
  await page.locator(".puzzle-button").click();
  await page.locator(".day", { hasText: /^4$/ }).click();
  await expect(page.locator(".puzzle-button")).toContainText("day 4");
});

test("keeps the code scrolled where it was when an edit makes a line long, unless typing", async () => {
  const scrolledSideways = () => page.locator(".cm-scroller").evaluate((e) => e.scrollLeft);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const before = readFileSync(solution, "utf8");
  await say("add a long comment");
  await expect(editor()).toContainText("well past the right edge");
  await page.waitForTimeout(300);
  expect(await scrolledSideways()).toBe(0);
  // Coming back puts the cursor where it was, at the end of the long line.
  await page.reload();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(editor()).toContainText("well past the right edge");
  await page.waitForTimeout(300);
  expect(await scrolledSideways()).toBe(0);
  // Moving along the line with keys follows the cursor.
  await page.locator(".cm-line", { hasText: "well past" }).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("End");
  await expect.poll(scrolledSideways).toBeGreaterThan(0);
  // Scrolled all the way, there is room beside the end of the line to tap.
  const room = await page.locator(".cm-scroller").evaluate((scroller) => {
    scroller.scrollLeft = scroller.scrollWidth;
    const line = [...scroller.querySelectorAll(".cm-line")].find((l) =>
      l.textContent?.includes("well past"),
    );
    if (!line) throw new Error("The long line isn't drawn");
    const text = document.createRange();
    text.selectNodeContents(line);
    return scroller.getBoundingClientRect().right - text.getBoundingClientRect().right;
  });
  expect(room).toBeGreaterThan(100);
  await expect.poll(() => readFileSync(solution, "utf8")).toContain("well past the right edge");
  writeFileSync(solution, before);
  await expect(editor()).not.toContainText("well past the right edge", { timeout: 15_000 });
});

test("wraps long lines only when chosen", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(editor()).not.toHaveClass(/cm-lineWrapping/);
  await openSettings("Display");
  await page.getByLabel("Wrap long lines of code").check();
  await closeSettings();
  await expect(editor()).toHaveClass(/cm-lineWrapping/);
  await page.reload();
  await expect(editor()).toHaveClass(/cm-lineWrapping/);
});

test("offers to install a missing package, and uses it", async () => {
  await say("use the lanterns package");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Run sample" }).click();
  await expect(page.locator(".run-result")).toContainText("No module named 'lanterns'", RUN);
  await page.getByRole("button", { name: "Close" }).click();

  await expect(page.locator(".banner")).toContainText("lanterns isn't installed.");
  await page.getByRole("button", { name: "Install lanterns" }).click();
  await expect(page.locator(".card", { hasText: "Installed lanterns" })).toBeVisible();
  await expect(page.locator(".banner")).toHaveCount(0);
  expect(readFileSync(join(HOME, "solutions", "python-packages.txt"), "utf8")).toMatch(
    /^lanterns$/m,
  );

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Run sample" }).click();
  await expect(page.locator(".run-result")).toContainText("Part 1: 3 ✓", RUN);
  await page.getByRole("button", { name: "Close" }).click();

  await openSettings("Packages");
  await expect(page.locator(".packages")).toContainText("lanterns");
  await expect(page.locator(".packages")).toContainText("Installed.");
  await closeSettings();
});

test("installs what's listed after the list is edited elsewhere", async () => {
  const manifest = join(HOME, "solutions", "python-packages.txt");
  writeFileSync(manifest, `${readFileSync(manifest, "utf8")}lanterns_extra\n`);
  await page.reload();
  await expect(page.locator(".banner")).toContainText("changed since the packages were installed");
  await page.locator(".banner").getByRole("button", { name: "Install" }).click();
  await expect(page.locator(".banner")).toHaveCount(0);

  await openSettings("Packages");
  await expect(page.locator(".packages")).toContainText("lanterns_extra");
  await page.getByRole("button", { name: "Remove lanterns_extra" }).click();
  await expect(page.locator(".packages")).not.toContainText("lanterns_extra");
  await expect(page.locator(".packages")).toContainText("Installed.");
  expect(readFileSync(manifest, "utf8")).not.toContain("lanterns_extra");
  await closeSettings();
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
    # When you start part 2, uncomment the next line.
    # print(part2(data))
`,
  );
  await page.locator(".puzzle-button").click();
  await page.getByRole("button", { name: "Practice puzzle" }).click();
  await expect(page.locator(".puzzle-button")).toContainText("Practice puzzle");
  await expect(page.locator(".problem")).toContainText("Practice: Sled Parcels");
  await expect(page.locator(".sample-summary")).toContainText("expects 2");
  // Reading the puzzle, there's nothing for the controls to do.
  await expect(page.locator(".talk")).toBeHidden();
  await page.getByRole("button", { name: "Code", exact: true }).click();

  for (const part of [1, 2]) {
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByRole("button", { name: "Run sample" }).click();
    await expect(page.locator(".run-result")).toContainText(
      `Part ${part}: ${part === 1 ? 2 : 45} ✓`,
      RUN,
    );
    await page.getByRole("button", { name: "Run real input" }).click();
    if (part === 2) {
      // Part 1's answer, checked against the one already accepted.
      await expect(page.locator(".run-result")).toContainText("✓ (as accepted)", RUN);
    }
    await page.getByRole("button", { name: new RegExp(`^Submit part ${part}: \\d+$`) }).click();
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.locator(".submitted").first()).toContainText("Correct!");
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.locator(".top")).toContainText("★".repeat(part));
    if (part === 1) {
      // Offered straight after the first star, as the template has part 2 commented out, and
      // again on coming back to the puzzle without having started it.
      await expect(page.getByRole("button", { name: "Start part 2" })).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "Start part 2" }).click();
      await expect(page.locator(".cm-content")).toContainText("    print(part2(data))");
      await expect(page.locator(".cm-content")).not.toContainText("# print(part2(data))");
      await openSettings("Solutions repo");
      await page.getByLabel("Commit and push after each star").check();
      await closeSettings();
    }
  }
  await expect(page.locator(".card", { hasText: "Committed." })).toBeVisible();

  await page.getByRole("button", { name: "Problem", exact: true }).click();
  await expect(page.locator(".problem")).toContainText("Part Two");
  await page.getByRole("button", { name: "Start again" }).click();
  await expect(page.locator(".problem")).not.toContainText("Part Two");
});

/** Holds the talk button while "saying" `text`, letting go after `ms`. */
async function hold(text: string, ms: number): Promise<void> {
  await page.evaluate((t) => {
    (window as unknown as { demoSpeech: { text: string } }).demoSpeech.text = t;
  }, text);
  const box = await page.locator(".talk").boundingBox();
  if (!box) throw new Error("The talk button isn't visible.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test("keeps what was said when the button is pressed again straight away", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await hold("undo", 300);
  // Before the first press's last words have arrived.
  await hold("redo", 300);
  await expect(card("done").filter({ hasText: "“undo”" })).toContainText("Undone");
  await expect(card("done").filter({ hasText: "“redo”" })).toContainText("Redone");
  await expect(page.locator(".card", { hasText: "Didn't catch anything" })).toHaveCount(0);
});

test("shows what's being said in one card, without replaying it as words arrive", async () => {
  await page.evaluate(() => {
    (window as unknown as { cardAnimations: { entrances: number } }).cardAnimations.entrances = 0;
  });
  await hold("go to line one and then go to line two please", 1200);
  await expect(
    page.locator(".card", { hasText: "go to line one and then go to line two please" }),
  ).toHaveClass(/\b(done|asked|problem)\b/);
  const entrances = await page.evaluate(
    () => (window as unknown as { cardAnimations: { entrances: number } }).cardAnimations.entrances,
  );
  // The listening card coming in; it then becomes the utterance's card, which doesn't.
  expect(entrances).toBe(1);
});

test("keeps what's being said still while a card above it leaves", async () => {
  await send("undo");
  await expect(card("done").filter({ hasText: "“undo”" }).last()).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { cardAnimations: { moves: string[] } }).cardAnimations.moves = [];
  });
  // Held for longer than a finished card lingers, so it leaves during the press.
  await hold("go to line one", 3500);
  await expect(page.locator(".card", { hasText: "“go to line one”" })).toHaveClass(
    /\b(done|asked|problem)\b/,
  );
  const moves = await page.evaluate(
    () => (window as unknown as { cardAnimations: { moves: string[] } }).cardAnimations.moves,
  );
  // The stack is anchored at the bottom, so a card leaving the top moves nothing below it.
  expect(moves.filter((m) => m.includes("live"))).toEqual([]);
});

test("talks while Ctrl is held on its own, but not when it's part of a shortcut", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const say = (text: string) =>
    page.evaluate((t) => {
      (window as unknown as { demoSpeech: { text: string } }).demoSpeech.text = t;
    }, text);

  await say("go to line two");
  await page.keyboard.down("Control");
  await expect(page.locator(".talk")).toHaveClass(/\blistening\b/);
  await page.waitForTimeout(800);
  await page.keyboard.up("Control");
  await expect(card("done").filter({ hasText: "“go to line two”" }).last()).toBeVisible();

  // Ctrl with another key is a shortcut, even once it's been held long enough to listen.
  await say("go to line three");
  await page.keyboard.down("Control");
  await expect(page.locator(".talk")).toHaveClass(/\blistening\b/);
  await page.keyboard.press("KeyK");
  await expect(page.locator(".talk")).not.toHaveClass(/\blistening\b/);
  await page.keyboard.up("Control");
  // A quick tap isn't long enough to listen.
  await page.keyboard.press("Control");
  await page.waitForTimeout(1500);
  await expect(page.locator(".card", { hasText: "go to line three" })).toHaveCount(0);
  await expect(page.locator(".card.live")).toHaveCount(0);
  await expect(page.locator(".card", { hasText: "Didn't catch" })).toHaveCount(0);
});

test("finishes a press when the page is left mid-press, keeping what was said", async () => {
  await page.evaluate(() => {
    (window as unknown as { demoSpeech: { text: string } }).demoSpeech.text = "go to line two";
  });
  const box = await page.locator(".talk").boundingBox();
  if (!box) throw new Error("The talk button isn't visible.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator(".talk")).toHaveClass(/\blistening\b/);
  await page.waitForTimeout(800);
  // As when the phone is locked: the page is hidden, and the button's release never comes.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".talk")).not.toHaveClass(/\blistening\b/);
  await expect(card("done").filter({ hasText: "“go to line two”" }).last()).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  await page.mouse.up();
});

test("waits for the editor when something is said while a puzzle is still opening", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.reload();
  // Straight away, before the editor has loaded.
  await send("change it");
  await expect(card("asked").filter({ hasText: "“change it”" })).toBeVisible();
  await expect(page.locator(".card", { hasText: "Open a puzzle first" })).toHaveCount(0);
});

test("says to hold the button after a quick tap that heard nothing", async () => {
  await hold("", 100);
  await expect(
    page.locator(".card", { hasText: "Hold the button while you speak." }),
  ).toBeVisible();
});

test("dictates with the keyboard when chosen, on this device", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await openSettings("Talking");
  await page.getByRole("button", { name: "Keyboard", exact: true }).click();
  await closeSettings();

  await page.getByRole("button", { name: "Tap to dictate" }).click();
  const box = page.locator(".composer textarea");
  await expect(box).toBeFocused();
  // As the keyboard's microphone would type it.
  await box.fill("undo");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(card("done").filter({ hasText: "“undo”" }).last()).toContainText("Undone");
  await expect(page.locator(".composer")).not.toHaveClass(/\bopen\b/);

  await openSettings("Talking");
  await page.getByRole("button", { name: "Automatic" }).click();
  await closeSettings();
  await expect(page.locator(".talk")).toHaveText("Hold to talk");
});

test("shows the puzzle beside the code on a wide screen", async () => {
  const phone = page.viewportSize();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.locator(".side .problem")).toBeVisible();
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator("nav.tabs").getByRole("button", { name: "Problem" })).toHaveCount(0);
  if (phone) await page.setViewportSize(phone);
  await expect(page.locator(".side")).toHaveCount(0);
  await expect(page.locator("nav.tabs").getByRole("button", { name: "Problem" })).toBeVisible();
});

test("waits for the server when it can't be reached, then carries on", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  // As if the server were asleep: nothing gets through.
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await send("change it");
  await expect(page.locator(".banner.offline")).toBeVisible();
  await expect(card("working").filter({ hasText: "“change it”" })).toContainText(
    "Waiting for the server",
  );
  await page.unroute("**/api/**");
  await expect(page.locator(".banner.offline")).toHaveCount(0, { timeout: 10_000 });
  await expect(card("asked").filter({ hasText: "“change it”" })).toBeVisible();
  await card("asked")
    .filter({ hasText: "“change it”" })
    .getByRole("button", { name: "Dismiss" })
    .click();
});

test("hears what's said with Whisper on the server, once its model is there", async () => {
  const model = join(HOME, "cache", "whisper", "ggml-small.en.bin");
  mkdirSync(join(HOME, "cache", "whisper"), { recursive: true });
  // The stand-in whisper-cli only checks it's given a recording.
  writeFileSync(model, "lmgg");
  // A microphone that hears a steady tone, loud enough not to be taken for silence.
  await page.addInitScript(() => {
    // One for every press, as browsers limit how many a page can have.
    let shared: AudioContext | null = null;
    // On the prototype, as WebKit can give the page a new `navigator.mediaDevices`.
    MediaDevices.prototype.getUserMedia = async () => {
      // Made while the button is pressed, as browsers only start audio in response to a press.
      shared ??= new AudioContext();
      const context = shared;
      const tone = context.createOscillator();
      const out = context.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      const resumed = context.resume();
      // As long as a phone's microphone takes to start, roughly, unless a test says otherwise.
      const delay = (window as unknown as { micDelayMs?: number }).micDelayMs ?? 300;
      await new Promise((r) => setTimeout(r, delay));
      await resumed;
      return out.stream;
    };
  });
  await page.reload();
  await page.getByRole("button", { name: "Code", exact: true }).click();

  // Automatic picks Whisper now it's ready.
  const box = await page.locator(".talk").boundingBox();
  if (!box) throw new Error("The talk button isn't visible.");

  // The first press, when the browser asks whether to allow the microphone and the button is let
  // go to answer.
  await page.evaluate(() => Object.assign(window, { micDelayMs: 2000 }));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(
    page.locator(".card", { hasText: "Microphone allowed. Now hold the button while you speak." }),
  ).toBeVisible();
  await page.evaluate(() => Object.assign(window, { micDelayMs: 300 }));

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator(".talk")).toHaveClass(/\bstarting\b/);
  await expect(page.locator(".card.live")).toContainText("Starting the microphone…");
  await expect(page.locator(".talk")).toHaveClass(/\blistening\b/);
  await expect(page.locator(".card.live")).toContainText("Listening…");
  await expect(page.locator(".card.live .level-meter")).toBeVisible();
  await page.waitForTimeout(1500);
  await page.mouse.up();
  await expect(page.locator(".card.live")).toContainText("Transcribing…");

  // A short press while the long one is still being heard: it's heard first, but handed over
  // second, as it was said second.
  await page.mouse.down();
  await expect(page.locator(".talk")).toHaveClass(/\bstarting\b/);
  await expect(page.locator(".talk")).toHaveClass(/\blistening\b/);
  await page.waitForTimeout(300);
  await page.mouse.up();
  const transcripts = page.locator(".card .card-transcript");
  await expect(transcripts).toHaveText(["“go to line one”", "“go to line two”"]);
  // Heard by whisper-server, which keeps the model loaded, rather than by whisper-cli.
  expect(readFileSync(join(HOME, "whisper-server-heard"), "utf8")).toContain("heard");

  // Said while the server can't be reached: kept until it can, then heard.
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.mouse.down();
  await expect(page.locator(".talk")).toHaveClass(/\blistening\b/);
  await page.waitForTimeout(300);
  await page.mouse.up();
  await expect(page.locator(".card.live")).toContainText("Waiting for the server…");
  await page.unroute("**/api/**");
  await expect(page.locator(".card.live")).toHaveCount(0, { timeout: 10_000 });
  await expect(transcripts.last()).toHaveText("“go to line two”");
  await expect(page.locator(".card", { hasText: "Couldn't hear" })).toHaveCount(0);

  // Cancelled while it's waiting to be heard: it just goes, and nothing is done with it.
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.mouse.down();
  await expect(page.locator(".talk")).toHaveClass(/\blistening\b/);
  await page.waitForTimeout(300);
  await page.mouse.up();
  await expect(page.locator(".card.live")).toContainText("Waiting for the server…");
  const heardBefore = await transcripts.count();
  await page.locator(".card.live").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".card.live")).toHaveCount(0);
  await page.unroute("**/api/**");
  await page.waitForTimeout(1500);
  expect(await transcripts.count()).toBeLessThanOrEqual(heardBefore);
  await expect(page.locator(".card", { hasText: "Couldn't hear" })).toHaveCount(0);
  await expect(page.locator(".card", { hasText: "Didn't catch" })).toHaveCount(0);

  await openSettings("Talking");
  await expect(page.locator(".server-speech")).toContainText("Whisper is ready");
  await closeSettings();
  rmSync(model);
  await page.reload();
});

test("shows a private leaderboard once one is chosen", async () => {
  await openSettings("Leaderboard");
  await page.getByLabel("Leaderboard ID").fill("12a");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".error-text")).toContainText("the number at the end");
  await page.getByLabel("Leaderboard ID").fill("123456");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Stop showing it" })).toBeVisible();
  await closeSettings();

  await page.locator(".puzzle-button").click();
  await page.getByRole("button", { name: "2017" }).click();
  const board = page.locator(".star-times", { hasText: "Leaderboard" });
  await expect(board.locator("tbody tr").first()).toContainText("Anonymous user #2");
  await expect(board).toContainText("Ada");
  await page.locator(".puzzle-button").click();

  await openSettings("Leaderboard");
  await page.getByRole("button", { name: "Stop showing it" }).click();
  await expect(page.getByRole("button", { name: "Stop showing it" })).toHaveCount(0);
  await closeSettings();
});

test("sends a test notification to a device that turns them on", async ({ browser }) => {
  // A push service of the test's own, keeping what's sent to it.
  const received: { headers: Record<string, string | string[] | undefined>; size: number }[] = [];
  const service = createServer((request, response) => {
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
    });
    request.on("end", () => {
      received.push({ headers: request.headers, size });
      response.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const { port } = service.address() as AddressInfo;
  // A device's keys, as a browser would make them.
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const subscription = {
    endpoint: `http://127.0.0.1:${port}/push/device`,
    expirationTime: null,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };

  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${PORT}` });
  await context.grantPermissions(["notifications"]);
  const device = await context.newPage();
  // Test browsers can't subscribe to a real push service, so this stands in for one.
  await device.addInitScript((json) => {
    let current: PushSubscription | null = null;
    const fake = {
      endpoint: json.endpoint,
      toJSON: () => json,
      unsubscribe: async () => {
        current = null;
        return true;
      },
    } as unknown as PushSubscription;
    PushManager.prototype.subscribe = async () => {
      current = fake;
      return fake;
    };
    PushManager.prototype.getSubscription = async () => current;
    // Answers the browser's question about notifications as a tap on Allow would, which not
    // every test browser lets the test do.
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    Notification.requestPermission = async () => "granted";
  }, subscription);
  const token = readFileSync(join(HOME, "config", "token"), "utf8").trim();
  await device.goto(`/?token=${token}`);
  await device.getByRole("button", { name: "Settings" }).click();
  await device.locator(".settings-row", { hasText: "Notifications" }).getByRole("button").click();
  const toggle = device.getByLabel("Notify me when puzzles unlock");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();

  await device.getByRole("button", { name: "Send a test notification" }).click();
  await expect(device.getByText("Sent: it should arrive in a moment.")).toBeVisible();
  expect(received).toHaveLength(1);
  expect(received[0]?.headers["content-encoding"]).toBe("aes128gcm");
  expect(String(received[0]?.headers.authorization)).toMatch(/^vapid t=/);

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(device.getByRole("button", { name: "Send a test notification" })).toHaveCount(0);
  await context.close();
  service.close();
});

test("counts down to the next puzzle, and offers today's", async ({ browser }) => {
  // The evening before day 4 of the fixture's year, in its own page so the clock is its own.
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${PORT}` });
  const december = await context.newPage();
  await december.clock.install({ time: new Date("2017-12-03T21:00:00Z") });
  const token = readFileSync(join(HOME, "config", "token"), "utf8").trim();
  await december.goto(`/?token=${token}`);
  await expect(december.locator(".card", { hasText: "Day 3 is out." })).toBeVisible();

  // The picker shows straight away if no puzzle has been opened yet.
  if (!(await december.locator(".picker").isVisible())) {
    await december.locator(".puzzle-button").click();
  }
  // Seven hours to go, stopped there, so the countdown reads the same however slowly the page
  // got here. Pausing a second short then fast-forwarding fires the countdown's timer, which
  // jumping doesn't.
  await december.clock.pauseAt(new Date("2017-12-03T21:59:59Z"));
  await december.clock.fastForward(1000);
  await expect(december.locator(".countdown")).toContainText("Day 4 unlocks in 7h 00m");
  await expect(december.getByRole("button", { name: "Day 4, not unlocked yet" })).toBeDisabled();
  await expect(december.locator(".star-times")).toContainText("1:02:03");
  await expect(december.locator(".day.today")).toHaveText("3★");

  await december.clock.fastForward("07:00:01");
  await expect(december.getByRole("button", { name: "Day 4, not unlocked yet" })).toHaveCount(0);
  await expect(december.locator(".day.today")).toContainText("4");
  await expect(december.locator(".countdown")).toContainText("Day 5 unlocks in");
  await context.close();
});

test("edits with Helix's keybindings, and keys from the config", async ({ browser }) => {
  // In its own page, so turning them on for this device leaves the other tests' page as it was.
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${PORT}` });
  const helix = await context.newPage();
  const token = readFileSync(join(HOME, "config", "token"), "utf8").trim();
  await helix.goto(`/?token=${token}`);
  // Day 4, whatever the other tests left open.
  const picker = helix.locator(".picker");
  await expect(picker.or(helix.locator(".puzzle-button")).first()).toBeVisible({ timeout: 15_000 });
  if (!(await picker.isVisible())) await helix.locator(".puzzle-button").click();
  await helix.getByRole("button", { name: "2017", exact: true }).click();
  await expect(picker).toContainText("5 stars in 2017");
  await helix.locator(".day", { hasText: /^4$/ }).click();
  // The puzzle switching over can briefly show two problems.
  await expect(
    helix.getByRole("heading", { name: "--- Day 4: Counting Lines ---" }).first(),
  ).toBeVisible();
  // A phone shows one tab at a time.
  const codeTab = helix.getByRole("navigation").getByRole("button", { name: "Code" });
  if (await codeTab.isVisible()) await codeTab.click();
  const code = helix.locator(".cm-content");
  await expect(code).toContainText("def part1");
  // What's saved, which is the text without what's drawn for the cursor.
  const saved = () => readFileSync(solution, "utf8");
  const original = saved();
  const firstLine = original.split("\n")[0] ?? "";
  const lines = () => saved().split("\n").slice(0, 2);

  await helix.getByRole("button", { name: "Settings" }).click();
  await helix.locator(".settings-row", { hasText: "Display" }).getByRole("button").click();
  await helix.getByLabel("Helix keybindings, for a keyboard").check();
  await helix.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  const mode = helix.locator(".cm-helix-mode");
  await expect(mode).toHaveText("NOR");
  await expect(helix.locator(".cm-helix-mode.cm-helix-color-modes")).toHaveCount(1);

  // Key help floats over the code in the corner, only as wide as it needs, as in Helix, rather
  // than across the editor, pushing the code up.
  await code.click();
  const scroller = helix.locator(".cm-scroller");
  const codeHeight = (await scroller.boundingBox())?.height;
  await helix.keyboard.press("g");
  const info = helix.locator(".cm-helix-info");
  await expect(info).toContainText("Goto");
  const [box, area] = [await info.boundingBox(), await scroller.boundingBox()];
  if (box === null || area === null) throw new Error("the key help or code isn't shown");
  expect(box.width).toBeLessThan(area.width * 0.9);
  expect(box.x + box.width).toBeGreaterThan(area.x + area.width * 0.9);
  expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height);
  expect(area.height).toBe(codeHeight);
  await helix.keyboard.press("Escape");
  await expect(info).toHaveCount(0);

  await code.click();
  const keys = async (...presses: string[]) => {
    for (const p of presses) await helix.keyboard.press(p);
  };
  // To the top, then select the first line and delete it, and undo that.
  await keys("g", "g", "x", "d");
  await expect.poll(lines).not.toContain(firstLine);
  await keys("u");
  await expect.poll(saved).toBe(original);

  // Insert mode, typed into, then back to normal mode.
  await keys("g", "g", "i");
  await expect(mode).toHaveText("INS");
  await helix.keyboard.type("x = 1");
  await keys("Enter", "Escape");
  await expect(mode).toHaveText("NOR");
  await expect.poll(lines).toEqual(["x = 1", firstLine]);

  // A key from the config: Alt-Up moves the cursor's line up, as a sequence of commands.
  await keys("Alt+ArrowUp");
  await expect.poll(lines).toEqual([firstLine, "x = 1"]);

  // Searching, and the command line.
  await keys("/");
  await expect(helix.locator(".cm-helix-prompt-label")).toHaveText("search:");
  await helix.keyboard.type("part1");
  await keys("Enter");
  await expect(helix.locator(".cm-helix-cursor-primary")).toHaveText("1");
  await keys(":");
  await helix.keyboard.type("w");
  await keys("Enter");
  await expect(helix.locator(".cm-helix-message")).toContainText("written");

  // Each key is one undo step, so undoing both edits puts the file back as it was.
  await keys("u", "u");
  await expect.poll(saved).toBe(original);
  await context.close();
});

/**
 * Whether each character Workshop's own keyboard types needs shift, after which its key shows the
 * character it types.
 */
const PLAIN_KEYS = new Map<string, { shift: boolean }>(
  LAYOUT.flatMap((row) => row.keys).flatMap((def) =>
    def.kind === "char" && def.label === undefined
      ? [[def.char, { shift: false }] as const, [charFor(def.char, true), { shift: true }] as const]
      : [],
  ),
);

/**
 * Holds a key on the page down, with a finger of its own, while `during` runs. The finger is a
 * mouse, as Playwright's touch screen can only tap, but the key takes it just the same.
 */
async function holdKey(page: Page, key: Locator, during: () => Promise<unknown>): Promise<void> {
  const box = await key.boundingBox();
  if (box === null) throw new Error("the key to hold isn't on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    await during();
  } finally {
    await page.mouse.up();
  }
}

/**
 * Opens 2017's day 4 on a phone, or a computer if asked, with Helix's keybindings unless others
 * are given, at its code.
 */
async function openOnPhone(
  browser: Browser,
  keybindings: "helix" | "default" = "helix",
  device: "phone" | "computer" = "phone",
): Promise<{ context: BrowserContext; phone: Page }> {
  const context = await browser.newContext({
    ...(device === "phone" ? devices["Pixel 7"] : {}),
    baseURL: `http://127.0.0.1:${PORT}`,
  });
  const phone = await context.newPage();
  await phone.addInitScript(
    (choice) => localStorage.setItem("workshop:keybindings", choice),
    keybindings,
  );
  const token = readFileSync(join(HOME, "config", "token"), "utf8").trim();
  await phone.goto(`/?token=${token}`);
  const picker = phone.locator(".picker");
  await expect(picker.or(phone.locator(".puzzle-button")).first()).toBeVisible({ timeout: 15_000 });
  if (!(await picker.isVisible())) await phone.locator(".puzzle-button").click();
  await phone.getByRole("button", { name: "2017", exact: true }).click();
  await expect(picker).toContainText("5 stars in 2017");
  await phone.locator(".day", { hasText: /^4$/ }).click();
  await phone.getByRole("navigation").getByRole("button", { name: "Code" }).click();
  await expect(phone.locator(".cm-content")).toContainText("def part1");
  return { context, phone };
}

/**
 * Pinches with two fingers either side of `centre`, from `from` pixels apart to `to`. Chromium
 * takes real touches through its DevTools protocol; Playwright has no other way to touch with two
 * fingers, and WebKit can't construct touches, so there the events carry plain points instead.
 */
async function pinch(
  phone: Page,
  centre: { x: number; y: number },
  from: number,
  to: number,
): Promise<void> {
  const steps = 8;
  const apart = (d: number): TwoFingers => [
    { x: centre.x - d / 2, y: centre.y },
    { x: centre.x + d / 2, y: centre.y },
  ];
  await touchWithTwoFingers(
    phone,
    Array.from({ length: steps + 1 }, (_, i) => apart(from + ((to - from) * i) / steps)),
  );
}

type TwoFingers = [{ x: number; y: number }, { x: number; y: number }];

/** Sweeps two fingers sideways together by `dx` pixels, from either side of `centre`. */
async function sweep(phone: Page, centre: { x: number; y: number }, dx: number): Promise<void> {
  const steps = 6;
  await touchWithTwoFingers(
    phone,
    Array.from({ length: steps + 1 }, (_, i): TwoFingers => {
      const x = centre.x + (dx * i) / steps;
      return [
        { x: x - 30, y: centre.y },
        { x: x + 30, y: centre.y + 20 },
      ];
    }),
  );
}

/**
 * Puts two fingers down at the first of `frames`, moves them through the rest, and lifts them.
 */
async function touchWithTwoFingers(phone: Page, frames: TwoFingers[]): Promise<void> {
  const [first, ...rest] = frames;
  if (first === undefined) throw new Error("two fingers need somewhere to touch");
  if (test.info().project.name === "chromium") {
    const cdp = await phone.context().newCDPSession(phone);
    const send = (type: "touchStart" | "touchMove" | "touchEnd", points: TwoFingers | null) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: (points ?? []).map((p, id) => ({ ...p, id })),
      });
    await send("touchStart", first);
    for (const points of rest) {
      await send("touchMove", points);
      await phone.evaluate(() => new Promise(requestAnimationFrame));
    }
    await send("touchEnd", null);
    await cdp.detach();
    return;
  }
  await phone.evaluate(
    async ({ frames }) => {
      const target = document.querySelector(".cm-editor");
      if (!target) throw new Error("there's no editor to touch");
      const fire = (type: string, points: { x: number; y: number }[]) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        const touches = points.map((p, identifier) => ({
          clientX: p.x,
          clientY: p.y,
          identifier,
          target,
        }));
        Object.defineProperty(event, "touches", { value: touches });
        target.dispatchEvent(event);
      };
      fire("touchstart", frames[0] ?? []);
      for (const points of frames.slice(1)) {
        fire("touchmove", points);
        await new Promise(requestAnimationFrame);
      }
      fire("touchend", []);
    },
    { frames },
  );
}

test("scales only the code when it's pinched, and in settings, on this device", async ({
  browser,
}) => {
  // Long enough to scroll, so the code between the fingers can be kept there as it grows.
  const original = readFileSync(solution, "utf8");
  writeFileSync(solution, `${original}\n${"# more\n".repeat(60)}`);
  const { context, phone } = await openOnPhone(browser, "default");
  await expect(phone.locator(".cm-content")).toContainText("# more");
  const fontSize = (selector: string) =>
    phone
      .locator(selector)
      .first()
      .evaluate((e) => Number.parseFloat(getComputedStyle(e).fontSize));
  const usual = await fontSize(".cm-content");
  const title = await fontSize(".tabs");
  const gutter = await fontSize(".cm-gutters");

  // Pinching between the fingers keeps the line there where it was.
  const line = phone.locator(".cm-line", { hasText: "def part1" });
  const before = await line.boundingBox();
  if (before === null) throw new Error("there's no line defining part1");
  const centre = { x: before.x + 60, y: before.y + before.height / 2 };
  await pinch(phone, centre, 100, 150);
  await expect.poll(() => fontSize(".cm-content")).toBeCloseTo(usual * 1.5, 0);
  const after = await line.boundingBox();
  if (after === null) throw new Error("the line defining part1 has gone");
  expect(after.y).toBeLessThanOrEqual(centre.y);
  expect(after.y + after.height).toBeGreaterThanOrEqual(centre.y);
  // Lines still start in view, beside the line numbers.
  expect(await phone.locator(".cm-scroller").evaluate((s) => s.scrollLeft)).toBe(0);
  // The line numbers grow with the code, but nothing else does, and the page isn't zoomed.
  expect(await fontSize(".cm-gutters")).toBeCloseTo(gutter * 1.5, 0);
  expect(await fontSize(".tabs")).toBe(title);
  expect(await phone.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);

  // Pinching right in shows the shape of the whole file, and pinching out again comes back.
  const middle = await phone.locator(".cm-editor").boundingBox();
  if (middle === null) throw new Error("there's no editor");
  const wide = { x: middle.x + middle.width / 2, y: middle.y + middle.height / 2 };
  await pinch(phone, wide, 200, 10);
  await expect.poll(() => fontSize(".cm-content")).toBeCloseTo(usual * 0.1, 1);
  await expect(phone.locator(".cm-line", { hasText: "# more" }).last()).toBeInViewport();
  // The line numbers stay beside their lines, rather than spaced for the size before.
  const lastLine = await phone.locator(".cm-line").last().boundingBox();
  const lastNumber = await phone.locator(".cm-lineNumbers .cm-gutterElement").last().boundingBox();
  if (lastLine === null || lastNumber === null) throw new Error("the last line has gone");
  expect(Math.abs(lastNumber.y - lastLine.y)).toBeLessThan(1);
  await pinch(phone, wide, 10, 150);
  await expect.poll(() => fontSize(".cm-content")).toBeCloseTo(usual * 1.5, 0);

  // Settings shows the pinched size, and steps from it.
  await phone.getByRole("button", { name: "Settings" }).click();
  await phone.locator(".settings-row", { hasText: "Display" }).getByRole("button").click();
  const dialog = phone.getByRole("dialog", { name: "Display" });
  const size = dialog.getByLabel("Code text size");
  await expect(size).toHaveText("150%");
  await dialog.getByRole("button", { name: "Larger code text" }).click();
  await expect(size).toHaveText("160%");
  expect(await fontSize(".cm-content")).toBeCloseTo(usual * 1.6, 0);

  // It's kept on this device across a reload, and can be put back as it was.
  await phone.reload();
  await expect(phone.locator(".cm-content")).toContainText("def part1");
  expect(await fontSize(".cm-content")).toBeCloseTo(usual * 1.6, 0);
  await phone.getByRole("button", { name: "Settings" }).click();
  await phone.locator(".settings-row", { hasText: "Display" }).getByRole("button").click();
  await dialog.getByRole("button", { name: "Reset" }).click();
  await expect(size).toHaveText("100%");
  await expect(dialog.getByRole("button", { name: "Reset" })).toHaveCount(0);
  expect(await fontSize(".cm-content")).toBe(usual);
  await context.close();
  writeFileSync(solution, original);
  await expect(editor()).not.toContainText("# more", { timeout: 15_000 });
});

test("glides the code when Helix's keys scroll it, ending where it would jump to", async ({
  browser,
}) => {
  // Long enough to scroll a good way.
  const original = readFileSync(solution, "utf8");
  writeFileSync(solution, `${original}\n${"# more\n".repeat(200)}`);
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${PORT}` });
  const helix = await context.newPage();
  await helix.addInitScript(() => localStorage.setItem("workshop:keybindings", "helix"));
  const token = readFileSync(join(HOME, "config", "token"), "utf8").trim();
  await helix.goto(`/?token=${token}`);
  const picker = helix.locator(".picker");
  await expect(picker.or(helix.locator(".puzzle-button")).first()).toBeVisible({ timeout: 15_000 });
  if (!(await picker.isVisible())) await helix.locator(".puzzle-button").click();
  await helix.getByRole("button", { name: "2017", exact: true }).click();
  await expect(picker).toContainText("5 stars in 2017");
  await helix.locator(".day", { hasText: /^4$/ }).click();
  const codeTab = helix.getByRole("navigation").getByRole("button", { name: "Code" });
  if (await codeTab.isVisible()) await codeTab.click();
  await expect(helix.locator(".cm-content")).toContainText("# more");
  await helix.locator(".cm-line").first().click();
  await expect(helix.locator(".cm-helix-mode")).toHaveText("NOR");
  const scroller = helix.locator(".cm-scroller");
  const scrollTop = () => scroller.evaluate((s) => s.scrollTop);
  /** Presses keys, and then where the code is once it's still. */
  const settledAfter = async (...keys: string[]) => {
    for (const key of keys) await helix.keyboard.press(key);
    let last = -1;
    await expect
      .poll(async () => {
        const [before, now] = [last, await scrollTop()];
        last = now;
        return before === now;
      })
      .toBe(true);
    return last;
  };

  // Where the keys jump to, with motion reduced, as some people choose.
  await helix.emulateMedia({ reducedMotion: "reduce" });
  const half = await settledAfter("Control+d");
  expect(half).toBeGreaterThan(0);
  const twoHalves = await settledAfter("Control+d");
  expect(twoHalves).toBeGreaterThan(half);
  expect(await settledAfter("g", "g")).toBe(0);
  // Paging down puts the cursor near the top of the page it shows.
  const cursorLine = () =>
    helix.locator(".cm-activeLine").evaluate((l) => l.getBoundingClientRect().top);
  const twoPages = await settledAfter("PageDown", "PageDown");
  const twoPagesCursor = await cursorLine();
  expect(await settledAfter("g", "g")).toBe(0);

  // Otherwise they glide there, through the lines between.
  await helix.emulateMedia({ reducedMotion: "no-preference" });
  await scroller.evaluate((s) => {
    const seen: number[] = [];
    Object.assign(window, { scrollsSeen: seen });
    const start = performance.now();
    const watch = () => {
      seen.push(s.scrollTop);
      if (performance.now() - start < 1000) requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  expect(await settledAfter("Control+d")).toBeCloseTo(half, 0);
  const seen = await helix.evaluate(
    () => (window as unknown as { scrollsSeen: number[] }).scrollsSeen,
  );
  expect(seen.some((top) => top > 1 && top < half - 1)).toBe(true);
  // Pressed again before the first has finished, they go as far as both would, without stopping
  // short.
  expect(await settledAfter("g", "g")).toBe(0);
  expect(await settledAfter("Control+d", "Control+d")).toBeCloseTo(twoHalves, 0);
  expect(await settledAfter("g", "g")).toBe(0);
  expect(await settledAfter("PageDown", "PageDown")).toBeCloseTo(twoPages, 0);
  expect(await cursorLine()).toBeCloseTo(twoPagesCursor, 0);

  // Back at the start, where the cursor is kept for the tests after, which tap the code near
  // the top of the file.
  await settledAfter("g", "g");
  await expect
    .poll(() => readFileSync(join(HOME, "data", "days", "2017-04.json"), "utf8"))
    .toMatch(/"cursor": *0\b/);
  await context.close();
  writeFileSync(solution, original);
  await expect(editor()).not.toContainText("# more", { timeout: 15_000 });
});

test("works on a phone with Helix's keybindings, from Workshop's own keyboard", async ({
  browser,
}) => {
  const { context, phone } = await openOnPhone(browser);
  const saved = () => readFileSync(solution, "utf8");
  const original = saved();
  const scroller = phone.locator(".cm-scroller");

  // Tapping the code leaves the starts of lines in view, beside the line numbers. Where, rather
  // than tapping the element, which would scroll it into view first, as no finger does.
  const line = await phone.locator(".cm-line").nth(3).boundingBox();
  if (line === null) throw new Error("the code has no fourth line");
  await phone.touchscreen.tap(line.x + 30, line.y + line.height / 2);
  // Tapping focuses a field of Helix's own, for keyboards plugged in, which never brings up the
  // phone's keyboard.
  const field = phone.locator(".cm-helix-keyboard");
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("inputmode", "none");
  // Tapping puts the cursor where it taps.
  const def = await phone.locator(".cm-line", { hasText: "def part1" }).boundingBox();
  if (def === null) throw new Error("there's no line defining part1");
  await phone.touchscreen.tap(def.x + 2, def.y + def.height / 2);
  await expect(phone.locator(".cm-helix-cursor-primary")).toHaveText("d");
  await phone.touchscreen.tap(def.x + 2, line.y + line.height / 2);
  await expect.poll(() => scroller.evaluate((s) => s.scrollLeft)).toBe(0);

  // Workshop's keyboard comes up in place of the controls, and only when asked for.
  const keyboard = phone.locator(".keyboard");
  const controls = phone.locator(".controls");
  await expect(keyboard).toBeHidden();
  await phone.getByRole("button", { name: "Type" }).tap();
  await expect(keyboard).toBeVisible();
  await expect(controls).toBeHidden();
  await expect(field).toHaveAttribute("inputmode", "none");
  // Helix's status line moves beneath the keys, into the space a phone's keyboard leaves there.
  await expect(keyboard.locator(".cm-helix-mode")).toHaveText("NOR");
  await expect(phone.locator(".cm-helix-status")).toHaveCount(1);

  const key = (name: string) => keyboard.getByRole("button", { name, exact: true });
  /** Types characters on the keyboard, tapping shift first for those it makes. */
  const type = async (text: string) => {
    for (const ch of text) {
      const plain = PLAIN_KEYS.get(ch);
      if (plain === undefined) throw new Error(`the keyboard has no key for '${ch}'`);
      if (plain.shift) await key("Shift").tap();
      await key(ch).tap();
    }
  };
  const mode = phone.locator(".cm-helix-mode");
  await type("ggi");
  await expect(mode).toHaveText("INS");
  await type("ab");
  await key("Backspace").tap();
  await expect.poll(() => saved().split("\n")[0]).toBe(`a${original.split("\n")[0]}`);
  // Shift, tapped, applies to the next key alone, and shows the keys as it makes them.
  await key("Shift").tap();
  await expect(key("Shift")).toHaveAttribute("aria-pressed", "true");
  await expect(key("@")).toBeVisible();
  await key("@").tap();
  await expect(key("Shift")).toHaveAttribute("aria-pressed", "false");
  await key("2").tap();
  await expect.poll(() => saved().split("\n")[0]).toBe(`a@2${original.split("\n")[0]}`);
  await key("Escape").tap();
  await expect(mode).toHaveText("NOR");
  await type("u");
  await expect.poll(saved).toBe(original);

  // No help for the keys after `g` covering the code, though what's pending still shows.
  await type("g");
  await expect(phone.locator(".cm-helix-pending")).toHaveText("g");
  await expect(phone.locator(".cm-helix-info")).toBeHidden();
  await key("Escape").tap();
  await expect(phone.locator(".cm-helix-pending")).toHaveText("");

  // Picking from a list by tapping it, as from the command palette.
  await key("Space").tap();
  await type("?yank_joined");
  await phone.locator(".cm-helix-picker-row").first().tap();
  await expect(phone.locator(".cm-helix-message")).toContainText("joined and yanked 1 selection");

  // Ctrl and Alt make the keys Helix binds with them: Ctrl-c comments the line, and Alt-u goes
  // back to before it.
  await type("gg");
  await key("Ctrl").tap();
  await type("c");
  await expect.poll(() => saved().split("\n")[0]).toMatch(/^# /);
  await key("Alt").tap();
  await type("u");
  await expect.poll(saved).toBe(original);

  // Moving within what's in view doesn't scroll.
  await type("%yppp");
  await type("gg");
  const top = await scroller.evaluate((s) => s.scrollTop);
  for (let i = 0; i < 3; i++) await type("j");
  await type("w");
  await expect(mode).toHaveText("NOR");
  expect(await scroller.evaluate((s) => s.scrollTop)).toBe(top);
  // Going well down the file does.
  await type("50j");
  await expect.poll(() => scroller.evaluate((s) => s.scrollTop)).toBeGreaterThan(top);
  for (let i = 0; i < 3; i++) await type("u");
  await expect.poll(saved).toBe(original);

  // Holding shift shifts every key until it's let go, as on a laptop.
  await type("ggi");
  await holdKey(phone, key("Shift"), async () => {
    await key("@").tap();
    await key("@").tap();
  });
  await key("2").tap();
  await expect.poll(() => saved().split("\n")[0]).toBe(`@@2${original.split("\n")[0]}`);
  // Holding a key presses it again and again: Backspace, held, deletes all three, at the start
  // of the file, where pressing it more does nothing.
  await holdKey(phone, key("Backspace"), () => phone.waitForTimeout(700));
  await expect.poll(saved).toBe(original);
  await key("Escape").tap();
  await expect(mode).toHaveText("NOR");

  // Leaving the app takes the focus from the field, as Chrome on Android otherwise brings up the
  // phone's keyboard for it on coming back.
  await phone.touchscreen.tap(def.x + 2, def.y + def.height / 2);
  await expect(field).toBeFocused();
  await phone.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(field).not.toBeFocused();
  await phone.touchscreen.tap(def.x + 2, def.y + def.height / 2);
  await expect(field).toBeFocused();
  await phone.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(field).not.toBeFocused();
  // The keyboard still types, needing no focus.
  await type("ggi");
  await expect(mode).toHaveText("INS");
  await key("Escape").tap();
  await expect(mode).toHaveText("NOR");

  // Only for the code: the problem's tab hides it, and coming back shows it again.
  await phone.getByRole("navigation").getByRole("button", { name: "Problem" }).click();
  await expect(keyboard).toBeHidden();
  await phone.getByRole("navigation").getByRole("button", { name: "Code" }).click();
  await expect(keyboard).toBeVisible();
  // Elsewhere, such as in the notes, the controls' keyboard button brings it back up, at the code.
  await phone.getByRole("navigation").getByRole("button", { name: "Notes" }).click();
  await expect(keyboard).toBeHidden();
  await phone.getByRole("button", { name: "Type" }).tap();
  await expect(keyboard).toBeVisible();
  await expect(phone.locator(".cm-content")).toBeVisible();
  // Lowering it brings the controls back.
  await key("Hide keyboard").tap();
  await expect(keyboard).toBeHidden();
  await expect(controls).toBeVisible();
  await expect(phone.locator(".cm-editor .cm-helix-mode")).toHaveText("NOR");

  // The Run panel covers the status line, which CodeMirror raises above the rest of the code.
  await phone.getByRole("button", { name: "Run", exact: true }).tap();
  await expect(phone.getByRole("dialog", { name: "Run" })).toBeVisible();
  const status = await phone.locator(".cm-helix-status").boundingBox();
  if (status === null) throw new Error("there's no status line");
  const covered = await phone.evaluate(
    ([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.closest(".modal-backdrop") !== null,
    [status.x + status.width / 2, status.y + status.height / 2],
  );
  expect(covered).toBe(true);
  await context.close();
});

test("presses the nearest key to a touch on Workshop's keyboard, and measures where keys are touched", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const { context, phone } = await openOnPhone(browser);
  const saved = () => readFileSync(solution, "utf8");
  const original = saved();
  const firstLine = () => saved().split("\n")[0];
  await phone.getByRole("button", { name: "Type" }).tap();
  const keyboard = phone.locator(".keyboard");
  const key = (name: string) => keyboard.getByRole("button", { name, exact: true });
  const boxOf = async (name: string) => {
    const box = await key(name).boundingBox();
    if (box === null) throw new Error(`the key ${name} isn't on screen`);
    return box;
  };
  for (const name of ["g", "g", "i"]) await key(name).tap();
  await expect(phone.locator(".cm-helix-mode")).toHaveText("INS");

  // Between two keys, a touch presses the nearer one.
  const [q, w, a] = [await boxOf("q"), await boxOf("w"), await boxOf("a")];
  const gap = w.x - (q.x + q.width);
  expect(gap).toBeGreaterThan(2);
  await phone.touchscreen.tap(q.x + q.width + gap * 0.8, q.y + q.height / 2);
  await expect.poll(firstLine).toBe(`w${original.split("\n")[0]}`);
  // Beside the keyboard's edge, and between rows, it presses the key nearest.
  await phone.touchscreen.tap(1, a.y + a.height / 2);
  await phone.touchscreen.tap(q.x + q.width / 2, q.y + q.height + 2);
  await expect.poll(firstLine).toBe(`waq${original.split("\n")[0]}`);
  await key("Escape").tap();
  await key("u").tap();
  await expect.poll(saved).toBe(original);
  await key("Hide keyboard").tap();

  // Typing the phrases a little to the right of every key's middle measures as much.
  await phone.getByRole("button", { name: "Settings" }).tap();
  await phone.getByRole("button", { name: /Display/ }).tap();
  await phone.getByRole("button", { name: "Measure where you touch the keys" }).tap();
  const measuring = phone.getByRole("dialog", { name: "Measure your typing" });
  const column = w.x - q.x;
  const off = Math.round(column * 0.3);
  const phrase = measuring.locator(".calibrate-phrase");
  const boxes = new Map<string, { x: number; y: number }>();
  const middleOf = async (char: string) => {
    let middle = boxes.get(char);
    if (middle === undefined) {
      const box = await measuring
        .locator(".keyboard")
        .getByRole("button", { name: char === " " ? "Space" : char, exact: true })
        .boundingBox();
      if (box === null) throw new Error(`no key for '${char}'`);
      middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      boxes.set(char, middle);
    }
    return middle;
  };
  // Each phrase shows with a mark for a space still to type, which isn't in what's to type.
  while (await phrase.isVisible()) {
    const text = ((await phrase.textContent()) ?? "").replace("␣", " ");
    for (const char of text) {
      const middle = await middleOf(char);
      await phone.touchscreen.tap(middle.x + off, middle.y);
    }
  }
  await expect(measuring).toContainText("missed the key they were for");
  await expect(measuring).toContainText(`${off}px right of the middle of a key`);
  await measuring.getByRole("button", { name: "Use what was measured" }).tap();
  await expect(measuring).toBeHidden();
  const kept = await phone.evaluate(() =>
    JSON.parse(localStorage.getItem("workshop:key-offsets") ?? "{}"),
  );
  expect(kept.q.x).toBeCloseTo(off / column, 1);

  // The keys are now where they were touched: what was the gap on q's right is q's.
  await phone.getByRole("button", { name: "Type" }).tap();
  await key("i").tap();
  await phone.touchscreen.tap(q.x + q.width + gap * 0.8, q.y + q.height / 2);
  await expect.poll(firstLine).toBe(`q${original.split("\n")[0]}`);
  await key("Escape").tap();
  await key("u").tap();
  await expect.poll(saved).toBe(original);
  await context.close();
});

test("asks the language server from Helix's own prompt and lists, on Workshop's keyboard", async ({
  browser,
}) => {
  const { context, phone } = await openOnPhone(browser);
  const saved = () => readFileSync(solution, "utf8");
  const original = saved();
  await phone.getByRole("button", { name: "Type" }).tap();
  const keyboard = phone.locator(".keyboard");
  const key = (name: string) => keyboard.getByRole("button", { name, exact: true });
  const type = async (text: string) => {
    for (const ch of text) {
      const plain = PLAIN_KEYS.get(ch);
      if (plain === undefined) throw new Error(`the keyboard has no key for '${ch}'`);
      if (plain.shift) await key("Shift").tap();
      await key(ch === " " ? "Space" : ch).tap();
    }
  };
  const rows = phone.locator(".cm-helix-picker-row");
  const selected = () =>
    phone
      .locator(".cm-helix-selection")
      .evaluateAll((els) => els.map((e) => e.textContent).join(""));
  const cursorLine = () =>
    phone.locator(".cm-line", { has: phone.locator(".cm-helix-cursor-primary") });
  // The language server has started once it's had its say about the file.
  await expect(phone.locator(".status-line")).toContainText("no errors", { timeout: 15_000 });

  // Going to a definition goes straight there, being the one place.
  await type("gg/print");
  await key("Enter").tap();
  await type("w");
  await type("w");
  await expect.poll(selected).toBe("part1");
  await expect(cursorLine()).toContainText("print(part1(data))");
  await type("gd");
  await expect(cursorLine()).toContainText("def part1");
  await expect.poll(selected).toBe("part1");

  // References are a list to pick from, in Helix's own picker, which the keyboard's keys work.
  await type("gr");
  await expect(phone.locator(".cm-helix-picker")).toContainText("References (2/2)");
  await expect(rows).toHaveText([/def part1.*line \d+/, /print\(part1\(data\)\).*line \d+/]);
  await expect(phone.locator(".cm-lsp-reference-panel")).toHaveCount(0);
  await rows.nth(1).tap();
  await expect(cursorLine()).toContainText("print(part1(data))");

  // Renaming asks for the name in Helix's prompt, beneath the keys, with the name now to change.
  await key("Space").tap();
  await type("r");
  await expect(keyboard.locator(".cm-helix-prompt-label")).toHaveText("rename-to:");
  await expect(keyboard.locator(".cm-helix-prompt-input")).toHaveText("part1 ");
  await expect(phone.locator(".cm-dialog")).toHaveCount(0);
  await type("x");
  await key("Enter").tap();
  await expect.poll(saved).toBe(original.replaceAll("part1", "part1x"));
  await expect(keyboard.locator(".cm-helix-message")).toHaveText("Renamed part1 to part1x");
  // As one change, which one undo takes back.
  await type("u");
  await expect.poll(saved).toBe(original);

  // Documentation shows as it's written, rather than as markdown's marks.
  await key("Space").tap();
  await type("k");
  const docs = phone.locator(".cm-helix-info-markdown");
  await expect(docs.locator("strong")).toHaveText("part1");
  await expect(docs.locator("pre")).toContainText("part1: str");
  await key("Escape").tap();

  // What the server offers to do is a list too. One comes without its edit until it's chosen,
  // one with it, and one can't be used, which goes last and says why.
  await type("gg");
  await type("Ooops");
  await key("Escape").tap();
  await expect.poll(saved).toBe(`oops\n${original}`);
  await expect(phone.locator(".status-line")).toContainText("1 error");
  await key("Space").tap();
  await type("a");
  await expect(rows).toHaveText([
    /^Remove oops/,
    /^Shout oops/,
    /^Explain oops.*Nothing can explain it/,
  ]);
  await rows.nth(2).tap();
  await expect(keyboard.locator(".cm-helix-error")).toHaveText("Nothing can explain it");
  await expect.poll(saved).toBe(`oops\n${original}`);
  await key("Space").tap();
  await type("a");
  await rows.nth(0).tap();
  await expect.poll(saved).toBe(`\n${original}`);
  await type("u");
  await expect.poll(saved).toBe(`oops\n${original}`);
  await key("Space").tap();
  await type("a");
  await rows.nth(1).tap();
  await expect.poll(saved).toBe(`OOPS\n${original}`);
  await expect(keyboard.locator(".cm-helix-message")).toHaveText("Shout oops");
  await type("uu");
  await expect.poll(saved).toBe(original);
  await context.close();
});

test("says what's wrong where the cursor is, and shows the whole of it when asked", async ({
  browser,
}) => {
  const { context, phone } = await openOnPhone(browser);
  const saved = () => readFileSync(solution, "utf8");
  const original = saved();
  await phone.getByRole("button", { name: "Type" }).tap();
  const keyboard = phone.locator(".keyboard");
  const key = (name: string) => keyboard.getByRole("button", { name, exact: true });
  const type = async (text: string) => {
    for (const ch of text) {
      const plain = PLAIN_KEYS.get(ch);
      if (plain === undefined) throw new Error(`the keyboard has no key for '${ch}'`);
      if (plain.shift) await key("Shift").tap();
      await key(ch === " " ? "Space" : ch).tap();
    }
  };
  await expect(phone.locator(".status-line")).toContainText("no errors", { timeout: 15_000 });
  await type("ggOoops");
  await key("Enter").tap();
  await type("hmm");
  await key("Escape").tap();
  await expect.poll(saved).toBe(`oops\nhmm\n${original}`);

  // The count, above the code and in Helix's status line, and the warning the cursor is on: its
  // first line alone, beneath the keys.
  await expect(phone.locator(".status-line")).toContainText("1 error, 1 warning");
  const problem = keyboard.locator(".cm-helix-problem");
  await expect(problem).toHaveText("hmm looks doubtful");
  await expect(keyboard.locator(".cm-helix-counts")).toHaveText("1E 1W");
  await type("k");
  await expect(problem).toHaveText("oops isn't a thing");
  // Off the error, there's nothing to say.
  await type("jj");
  await expect(problem).toHaveCount(0);
  await type("gg");

  // Tapping the code where it's underlined moves the cursor, and covers none of it.
  const oops = await phone.locator(".cm-lintRange-error").boundingBox();
  if (oops === null) throw new Error("nothing is underlined as an error");
  await phone.touchscreen.tap(oops.x + oops.width / 2, oops.y + oops.height / 2);
  await expect(problem).toHaveText("oops isn't a thing");
  await phone.waitForTimeout(600);
  await expect(phone.locator(".cm-tooltip")).toHaveCount(0);

  // Tapping what it says shows every problem, each in full, starting at this one, along the
  // bottom of the screen or over all of it.
  await problem.tap();
  const sheet = phone.getByRole("dialog", { name: "2 problems" });
  await expect(sheet).toBeVisible();
  const rows = sheet.locator(".problem-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("error, line 1");
  await expect(rows.first()).toContainText("last line of the error");
  await expect(rows.first()).toHaveClass(/current/);
  const height = async () => (await sheet.boundingBox())?.height ?? 0;
  const short = await height();
  await sheet.getByRole("button", { name: "Use the whole screen" }).tap();
  await expect.poll(height).toBeGreaterThan(short + 100);
  // Choosing one goes to it.
  await rows.nth(1).tap();
  await expect(sheet).toBeHidden();
  await expect(problem).toHaveText("hmm looks doubtful");
  // The counts open the list too.
  await keyboard.locator(".cm-helix-counts").tap();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).tap();
  await type("uu");
  await expect.poll(saved).toBe(original);
  await context.close();

  // Without Helix's keybindings there's no status line of its own, so it's said above the code.
  const { context: desk, phone: computer } = await openOnPhone(browser, "default", "computer");
  await expect(computer.locator(".status-line")).toContainText("no errors", { timeout: 15_000 });
  await computer.locator(".cm-content").click();
  await computer.keyboard.press("ControlOrMeta+Home");
  await computer.keyboard.type("oops");
  await computer.keyboard.press("Enter");
  await expect(computer.locator(".status-line")).toContainText("1 error");
  await computer.keyboard.press("ArrowUp");
  const said = computer.locator(".status-problem");
  await expect(said).toHaveText("oops isn't a thing");
  await said.click();
  await expect(computer.getByRole("dialog", { name: "1 problem" })).toContainText(
    "last line of the error",
  );
  await computer.keyboard.press("Escape");
  // A mouse can still point at it, for a message kept to a size that leaves the code in view.
  await computer.locator(".cm-lintRange-error").hover();
  const tooltip = computer.locator(".cm-tooltip-lint");
  await expect(tooltip).toContainText("oops isn't a thing");
  const viewport = computer.viewportSize();
  if (viewport === null) throw new Error("the page has no size");
  expect((await tooltip.boundingBox())?.height ?? 0).toBeLessThanOrEqual(viewport.height * 0.4 + 1);
  await computer.locator(".cm-content").click();
  await computer.keyboard.press("ControlOrMeta+z");
  await computer.keyboard.press("ControlOrMeta+z");
  await expect.poll(saved).toBe(original);
  await desk.close();
});

test("turns to other tabs in zen mode with two fingers, keeping the keyboard for the code", async ({
  browser,
}) => {
  const { context, phone } = await openOnPhone(browser);
  // Phones can't always go full screen where the tests run, which zen mode says and carries on.
  await phone.getByRole("button", { name: "Zen mode" }).tap();
  const keyboard = phone.locator(".keyboard");
  const code = phone.locator(".cm-content");
  const problem = phone.locator(".problem");
  const shown = phone.locator(".zen-tabs .selected");
  await expect(keyboard).toBeVisible();
  await expect(code).toBeVisible();
  await expect(phone.locator("nav.tabs")).toBeHidden();
  const middle = { x: 200, y: 200 };

  // Sweeping right turns back to the puzzle, still in zen mode, with the keyboard out of the way.
  await sweep(phone, middle, 150);
  await expect(problem).toBeVisible();
  await expect(shown).toHaveText("Problem");
  await expect(code).toBeHidden();
  await expect(keyboard).toBeHidden();
  await expect(phone.locator("nav.tabs")).toBeHidden();
  await expect(phone.getByRole("button", { name: "Leave zen mode" })).toBeVisible();
  // There's nothing before the first tab.
  await sweep(phone, middle, 150);
  await expect(shown).toHaveText("Problem");

  // Sweeping left turns on through the tabs, and the keyboard comes back with the code.
  await sweep(phone, middle, -150);
  await expect(code).toBeVisible();
  await expect(shown).toHaveText("Code");
  await expect(keyboard).toBeVisible();
  await sweep(phone, middle, -150);
  await expect(phone.locator(".notes textarea")).toBeVisible();
  await expect(keyboard).toBeHidden();
  await sweep(phone, middle, 150);
  await expect(keyboard).toBeVisible();

  // Two fingers on the keyboard are two keys, and a short or slanting sweep is nothing.
  const box = await keyboard.boundingBox();
  if (box === null) throw new Error("the keyboard isn't showing");
  await sweep(phone, { x: 200, y: box.y + box.height / 2 }, 150);
  await sweep(phone, middle, 40);
  await expect(code).toBeVisible();

  // Sweeping over the code doesn't change its size, as pinching it does.
  expect(await phone.evaluate(() => localStorage.getItem("workshop:code-scale"))).toBeNull();

  // With the keyboard lowered, it stays lowered on coming back.
  await keyboard.getByRole("button", { name: "Hide keyboard" }).tap();
  await sweep(phone, middle, 150);
  await sweep(phone, middle, -150);
  await expect(code).toBeVisible();
  await expect(keyboard).toBeHidden();
  await phone.getByRole("button", { name: "Leave zen mode" }).tap();
  await expect(phone.locator("nav.tabs")).toBeVisible();
  await context.close();
});

test("types and deletes in Helix's insert mode however a keyboard other than Workshop's sends it", async ({
  browser,
}) => {
  const { context, phone } = await openOnPhone(browser);
  const code = phone.locator(".cm-content");
  const saved = () => readFileSync(solution, "utf8");
  const original = saved();
  const [first = "", second = ""] = original.split("\n");
  const firstLines = () => saved().split("\n").slice(0, 2);
  const field = phone.locator(".cm-helix-keyboard");
  await field.focus();

  /** Input an on-screen keyboard sends, which Helix can take instead of the browser. */
  const input = (inputType: string, data: string | null = null, cancelable = true) =>
    field.evaluate(
      (el, [type, text, canCancel]) =>
        el.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: type as string,
            data: text as string | null,
            bubbles: true,
            cancelable: canCancel as boolean,
          }),
        ),
      [inputType, data, cancelable] as const,
    );
  /**
   * The field as the keyboard leaves it after an edit Helix couldn't stop, given what it holds
   * after the character always in it.
   */
  const fieldEdit = (value: string, composing = false) =>
    field.evaluate(
      (el, [text, isComposing]) => {
        const area = el as HTMLTextAreaElement;
        area.value = text as string;
        area.dispatchEvent(
          new InputEvent("input", { bubbles: true, isComposing: isComposing as boolean }),
        );
      },
      [value, composing] as const,
    );
  const compositionStart = () =>
    field.evaluate((el) =>
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
    );
  const SENTINEL = "\u200b";
  const mode = phone.locator(".cm-helix-mode");
  const pressEscape = () => phone.keyboard.press("Escape");

  for (const key of ["g", "g", "i"]) await input("insertText", key);
  await expect(mode).toHaveText("INS");
  // Typed, then backspaced, as input events.
  await input("insertText", "abcd");
  await input("deleteContentBackward");
  await input("deleteContentBackward");
  await expect.poll(firstLines).toEqual([`ab${first}`, second]);
  // As key presses.
  await phone.keyboard.press("Backspace");
  await expect.poll(firstLines).toEqual([`a${first}`, second]);
  // A key press the browser also carries out, as an iPhone can for Backspace, counts once.
  await code.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        code: "Backspace",
        bubbles: true,
        cancelable: true,
      }),
    );
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "deleteContentBackward",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect.poll(firstLines).toEqual([first, second]);
  // Edits the keyboard makes to its field that Helix can't stop: typing, and Backspace, which
  // deletes the character the field always holds.
  await fieldEdit(`${SENTINEL}xyz`);
  await expect.poll(firstLines).toEqual([`xyz${first}`, second]);
  await input("deleteContentBackward", null, false);
  await fieldEdit("");
  await expect.poll(firstLines).toEqual([`xy${first}`, second]);
  await fieldEdit("");
  await expect.poll(firstLines).toEqual([`x${first}`, second]);
  // Enter, and deleting a word.
  await input("insertParagraph");
  await expect.poll(firstLines).toEqual(["x", first]);
  await input("insertText", "foo bar");
  await input("deleteWordBackward");
  await expect.poll(firstLines).toEqual(["x", `foo ${first}`]);
  await pressEscape();
  await expect(mode).toHaveText("NOR");
  // Appending, and opening a line below, then backspacing there.
  await input("insertText", "A");
  await expect(mode).toHaveText("INS");
  await input("insertText", "!!");
  await input("deleteContentBackward");
  await pressEscape();
  await input("insertText", "o");
  await input("insertText", "zz");
  await input("deleteContentBackward");
  await pressEscape();
  await expect.poll(() => saved().split("\n").slice(0, 3)).toEqual(["x", `foo ${first}!`, "z"]);

  // A keyboard that composes words, as Gboard does, sends each letter as it's added, so normal
  // mode's keys work as they're pressed. Here `mi(` selects inside `part1(...)`, with "mi"
  // composed as a word, and the bracket ending it.
  await input("insertText", "/data:");
  await input("insertParagraph");
  await compositionStart();
  await fieldEdit(`${SENTINEL}m`, true);
  await fieldEdit(`${SENTINEL}mi`, true);
  // Then, as Safari does, one more input event at once, with the field as it was.
  await field.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent("compositionend", { data: "mi", bubbles: true }));
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await input("insertText", "(");
  await input("insertText", "cx");
  await pressEscape();
  await expect.poll(saved).toContain("def part1(x) -> int:");

  for (let i = 0; i < 5; i++) await input("insertText", "u");
  await expect.poll(saved).toBe(original);
  await context.close();
});
