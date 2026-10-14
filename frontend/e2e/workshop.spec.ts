import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  await expect(page.locator(".run-result")).toContainText("Part 1: 3 ✓");
  await page.getByRole("button", { name: "Run real input" }).click();
  await expect(page.locator(".run-result")).toContainText("Part 1: 5");
  await page.getByRole("button", { name: "Close" }).click();
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
  await expect(page.locator(".run-result")).toContainText("Part 1: 7");
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
  await expect(page.locator(".card", { hasText: "Installed lanterns" })).toBeVisible();
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
    );
    await page.getByRole("button", { name: "Run real input" }).click();
    await page.getByRole("button", { name: new RegExp(`^Submit part ${part}: \\d+$`) }).click();
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.locator(".submitted").first()).toContainText("Correct!");
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.locator(".top")).toContainText("★".repeat(part));
    if (part === 1) {
      // Offered straight after the first star, as the template has part 2 commented out.
      await page.getByRole("button", { name: "Start part 2" }).click();
      await expect(page.locator(".cm-content")).toContainText("    print(part2(data))");
      await expect(page.locator(".cm-content")).not.toContainText("# print(part2(data))");
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByLabel("Commit and push after each star").check();
      await page.keyboard.press("Escape");
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
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Keyboard dictation" }).click();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Tap to dictate" }).click();
  const box = page.locator(".composer textarea");
  await expect(box).toBeFocused();
  // As the keyboard's microphone would type it.
  await box.fill("undo");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(card("done").filter({ hasText: "“undo”" }).last()).toContainText("Undone");
  await expect(page.locator(".composer")).not.toHaveClass(/\bopen\b/);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Automatic" }).click();
  await page.keyboard.press("Escape");
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
    navigator.mediaDevices.getUserMedia = async () => {
      // As long as a phone's microphone takes to start, roughly.
      await new Promise((r) => setTimeout(r, 300));
      const context = new AudioContext();
      const tone = context.createOscillator();
      const out = context.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      return out.stream;
    };
  });
  await page.reload();
  await page.getByRole("button", { name: "Code", exact: true }).click();

  // Automatic picks Whisper now it's ready.
  const box = await page.locator(".talk").boundingBox();
  if (!box) throw new Error("The talk button isn't visible.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator(".talk")).toHaveClass(/\bstarting\b/);
  await expect(page.locator(".card.live")).toContainText("Starting the microphone…");
  await expect(page.locator(".talk")).toHaveClass(/\blistening\b/);
  await expect(page.locator(".card.live")).toContainText("Listening…");
  await page.waitForTimeout(400);
  await page.mouse.up();
  await expect(page.locator(".card.live")).toContainText("Hearing…");

  // Again while the first is still being heard: it starts, and then listens, just the same.
  await page.mouse.down();
  await expect(page.locator(".talk")).toHaveClass(/\bstarting\b/);
  await expect(page.locator(".talk")).toHaveClass(/\blistening\b/);
  await page.waitForTimeout(400);
  await page.mouse.up();
  await expect(card("done").filter({ hasText: "“undo”" })).toHaveCount(2);

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".server-speech")).toContainText("Whisper is ready");
  await page.keyboard.press("Escape");
  rmSync(model);
  await page.reload();
});
