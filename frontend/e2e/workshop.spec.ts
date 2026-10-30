import { createECDH, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
  await december.clock.install({ time: new Date("2017-12-03T22:00:00Z") });
  const token = readFileSync(join(HOME, "config", "token"), "utf8").trim();
  await december.goto(`/?token=${token}`);
  await expect(december.locator(".card", { hasText: "Day 3 is out." })).toBeVisible();

  // The picker shows straight away if no puzzle has been opened yet.
  if (!(await december.locator(".picker").isVisible())) {
    await december.locator(".puzzle-button").click();
  }
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
