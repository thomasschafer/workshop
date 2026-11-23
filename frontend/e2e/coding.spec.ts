import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BrowserContext,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { CODING_HOME, CODING_PORT, FAKE_LSP_FAILS } from "./fixture";
import { setOffline } from "./offline";
import { holdToTalk, installSimulatedSpeech } from "./speech";

// One learner on one phone, working through a problem of the sample pack's a step at a time,
// with Helix's keybindings and Workshop's own keyboard, from a server that starts with nothing
// done. The model and the language server are the tests' stand-ins.
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;

const token = () => readFileSync(join(CODING_HOME, "config", "token"), "utf8").trim();
const ITEM = "/api/coding/items/sample/first-repeat";

/** Replaces a problem's Python draft on the server, as typing it in full would. */
async function writeCode(text: string, item = ITEM): Promise<void> {
  const opened = await phone.request.post(`${item}/open`);
  expect(opened.ok()).toBe(true);
  const { languages } = (await opened.json()) as {
    languages: { id: string; code: { version: string } }[];
  };
  const python = languages.find((l) => l.id === "python");
  if (!python) throw new Error("the problem has no Python draft");
  const saved = await phone.request.put(`${item}/code/python`, {
    data: { text, version: python.code.version },
  });
  expect(saved.ok()).toBe(true);
}

async function overviewStatus(key: string): Promise<string> {
  const response = await phone.request.get("/api/coding?utc_offset=0");
  const { items } = (await response.json()) as { items: { key: string; status: string }[] };
  return items.find((item) => item.key === key)?.status ?? "missing";
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${CODING_PORT}`,
  });
  phone = await context.newPage();
  await phone.addInitScript(() => localStorage.setItem("workshop:keybindings", "helix"));
  await phone.addInitScript(installSimulatedSpeech, 20);
  await phone.goto(`/?token=${token()}`);
});

test.afterAll(async () => {
  await context?.close();
});

test("offers the Coding track at home, starting with something quick", async () => {
  const coding = phone.locator(".track", { hasText: "Coding" });
  await expect(coding).toContainText("23 new");
  const next = phone.locator(".continue");
  await expect(next).toContainText("Adding to a global");
  await expect(next).toContainText("Coding · Something new");
  await coding.tap();
  await expect(phone).toHaveURL(/\/coding$/);
  await expect(phone.locator(".coding-item")).toHaveCount(23);
  await expect(phone.locator(".coding-item", { hasText: "Count the islands" })).toContainText(
    "Problem · New",
  );
});

test("reads code and says what it prints, checked on the phone", async () => {
  await phone.locator(".coding-item", { hasText: "Dividing negative numbers" }).tap();
  await expect(phone).toHaveURL(/\/coding\/sample\/negative-division$/);
  await expect(phone.locator(".learn-prompt")).toContainText("std::cout");
  // Highlighted as C++, as its code block is marked.
  await expect(phone.locator(".learn-prompt .syntax-type").first()).toHaveText("int");
  // The way back to the list carries the track's icon.
  await expect(
    phone.getByRole("button", { name: "Coding" }).locator('[data-icon="code"]'),
  ).toBeVisible();
  await phone.getByLabel("What it prints").fill("-4 1");
  await phone.getByRole("button", { name: "Check" }).tap();
  await expect(phone.locator(".learn-verdict")).toHaveText("It prints:");
  await expect(phone.locator(".learn-printed")).toHaveText("-3 -1");
  await phone.getByRole("button", { name: "Next" }).tap();
  await expect(phone).toHaveURL(/\/coding$/);
  // The list asks the server once the answer's reached it.
  const read = phone.locator(".coding-item", { hasText: "Dividing negative numbers" });
  await expect(read).toContainText("Code to read ·");
  await expect(read).not.toContainText("· New");
  expect(await overviewStatus("sample/negative-division")).not.toBe("new");
});

test("retires code to read answered right as too easy, and brings it back from the list", async () => {
  await phone.locator(".coding-item", { hasText: "When a map's closure runs" }).tap();
  await phone.getByLabel("What it prints").fill("start 1 2 3 Some(6)");
  await phone.getByRole("button", { name: "Check" }).tap();
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await expect(phone.getByRole("button", { name: "Got it" })).toBeFocused();
  await phone.getByRole("button", { name: "Too easy: retire it" }).tap();
  await expect(phone).toHaveURL(/\/coding$/);
  // Listed with the retired problems, rather than among what's to do.
  const retired = phone.getByRole("region", { name: "Retired" });
  await expect(retired).toContainText("When a map's closure runs");
  expect(await overviewStatus("sample/lazy-map")).toBe("retired");
  await expect(phone.locator(".coding-item", { hasText: "When a map's closure runs" })).toHaveCount(
    0,
  );
  await retired.getByRole("button", { name: "Bring back" }).tap();
  await expect(retired).toHaveCount(0);
  await expect(
    phone.locator(".coding-item", { hasText: "When a map's closure runs" }),
  ).toContainText("Code to read · Due");
});

test("understands and plans a problem, each step saved, and carries on after a reload", async () => {
  await phone.locator(".coding-item", { hasText: "The first word to repeat" }).tap();
  await expect(phone).toHaveURL(/\/coding\/sample\/first-repeat$/);
  await expect(phone.locator(".step.current")).toHaveText("Understand");
  await expect(phone.getByRole("region", { name: "Example 1" })).toContainText("the tide came in");
  await phone.getByLabel("What should it print?").fill("the");
  await phone.getByRole("button", { name: "Check" }).tap();
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await phone.getByRole("button", { name: "Next: plan" }).tap();

  await expect(phone.locator(".step.current")).toHaveText("Plan");
  const plan = phone.getByLabel("How will you solve it?");
  await plan.fill("Keep a set of the words seen so far.");
  // Held to dictate, what's said is added on a line of its own.
  await phone.evaluate(() => {
    (window as unknown as { demoSpeech: { text: string } }).demoSpeech.text =
      "the first one already in it is the answer";
  });
  const dictate = phone.getByRole("button", { name: "Hold to dictate" });
  const box = await dictate.boundingBox();
  if (box === null) throw new Error("the dictate button isn't on screen");
  await phone.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await phone.mouse.down();
  await expect(phone.locator(".dictate-hearing")).toContainText("the answer");
  await phone.mouse.up();
  await expect(plan).toHaveValue(
    "Keep a set of the words seen so far.\nthe first one already in it is the answer",
  );

  // Saved as it goes, and kept on the phone only until it is, so a reload, or coming back later,
  // carries on from here.
  await expect
    .poll(() =>
      phone.evaluate(() =>
        localStorage.getItem("workshop:unsaved:coding-session:sample/first-repeat"),
      ),
    )
    .toBeNull();
  const listed = await (await phone.request.get("/api/coding?utc_offset=0")).json();
  expect(
    (listed as { items: { key: string; step: string }[] }).items.find(
      (item) => item.key === "sample/first-repeat",
    )?.step,
  ).toBe("plan");
  await phone.reload();
  await expect(phone.locator(".step.current")).toHaveText("Plan");
  await expect(phone.getByLabel("How will you solve it?")).toHaveValue(/first one already in it/);
  await phone.getByRole("banner").getByRole("button", { name: "Home" }).tap();
  const next = phone.locator(".continue");
  await expect(next).toContainText("The first word to repeat");
  await expect(next).toContainText("Where you left off, planning");
  await next.tap();
  await expect(phone.locator(".step.current")).toHaveText("Plan");
});

test("codes on the phone with Helix's keys, its own keyboard and the language server", async () => {
  await phone.getByRole("button", { name: "Next: code" }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Code");
  const editor = phone.locator(".cm-content");
  await expect(editor).toContainText("def first_repeat");
  // The editor and the keyboard fit on the phone's screen, without scrolling sideways.
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

  await phone.getByRole("button", { name: "Type" }).tap();
  const keyboard = phone.locator(".keyboard");
  await expect(keyboard).toBeVisible();
  await expect(keyboard.locator(".cm-helix-mode")).toHaveText("NOR");
  const key = (name: string) => keyboard.getByRole("button", { name, exact: true });
  // Opening a line above the first and typing a word the stand-in language server calls an
  // error, which it underlines and counts.
  await key("g").tap();
  await key("g").tap();
  await key("Shift").tap();
  await key("O").tap();
  await expect(keyboard.locator(".cm-helix-mode")).toHaveText("INS");
  for (const ch of "oops") await key(ch).tap();
  await key("Escape").tap();
  await expect(editor).toContainText("oops");
  await expect(phone.locator(".status-line")).toContainText("1 error", { timeout: 15_000 });
  await key("u").tap();
  await expect(editor).not.toContainText("oops");
  await expect(phone.locator(".status-line")).toContainText("no errors", { timeout: 15_000 });
  await keyboard.getByRole("button", { name: "Hide keyboard" }).tap();
  await expect(keyboard).toBeHidden();

  // A pack's hints come one at a time, without the server.
  await phone.getByRole("button", { name: "A hint" }).tap();
  await expect(phone.getByRole("list", { name: "Hints" }).locator("li")).toHaveCount(1);

  // What was typed is saved on the server, and kept on the phone only until it is.
  await expect
    .poll(() =>
      phone.evaluate(() =>
        localStorage.getItem("workshop:unsaved:coding:sample/first-repeat:python"),
      ),
    )
    .toBeNull();
  // Code saved elsewhere is on the server, and the editor picks it up when it's opened.
  await writeCode("print('none')\n");
  await phone.reload();
  await expect(phone.locator(".step.current")).toHaveText("Code");
  await expect(editor).toContainText("print('none')");
  await phone.getByRole("button", { name: "Run examples" }).tap();
  const results = phone.getByRole("region", { name: "Examples run" });
  await expect(results).toContainText("1 of 2 examples right", { timeout: 20_000 });
  await expect(results).toContainText("Example 1: Wrong answer");
  await expect(results.locator(".coding-case.wrong .coding-io").first()).toContainText(
    "the tide came in",
  );
});

test("codes in zen mode, with just the code and the keyboard", async () => {
  const editor = phone.locator(".cm-content");
  const keyboard = phone.locator(".keyboard");
  await phone.getByRole("button", { name: "Zen mode" }).tap();
  await expect(keyboard).toBeVisible();
  for (const hidden of [".top", ".steps", ".coding-toolbar", ".coding-actions", ".status-line"]) {
    await expect(phone.locator(hidden)).toBeHidden();
  }
  await expect(editor).toBeVisible();
  // Full screen where the browser allows it, which iPhones' doesn't.
  const fullscreen = await phone.evaluate(() => document.fullscreenEnabled === true);
  await expect
    .poll(() => phone.evaluate(() => document.fullscreenElement !== null))
    .toBe(fullscreen);

  // Lowered, the keyboard comes back from a button of its own, as the footer stays hidden.
  await keyboard.getByRole("button", { name: "Hide keyboard" }).tap();
  await expect(keyboard).toBeHidden();
  await expect(phone.locator(".coding-actions")).toBeHidden();
  await phone.getByRole("button", { name: "Show keyboard" }).tap();
  await expect(keyboard).toBeVisible();
  await keyboard.getByRole("button", { name: "Hide keyboard" }).tap();

  await phone.getByRole("button", { name: "Leave zen mode" }).tap();
  await expect(phone.locator(".steps")).toBeVisible();
  await expect(phone.locator(".coding-actions")).toBeVisible();
  await expect.poll(() => phone.evaluate(() => document.fullscreenElement !== null)).toBe(false);

  // Going back leaves zen mode too, staying on the problem.
  await phone.getByRole("button", { name: "Zen mode" }).tap();
  await expect(phone.locator(".steps")).toBeHidden();
  await phone.goBack();
  await expect(phone.getByRole("button", { name: "Leave zen mode" })).toHaveCount(0);
  await expect(phone.locator(".step.current")).toHaveText("Code");
});

test("brings up the phone's own keyboard for the code without Helix's keybindings", async () => {
  // A page of its own, as the phone's page turns Helix's keybindings on as it loads.
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("workshop:keybindings", "default"));
  await page.goto(phone.url());
  await expect(page.locator(".step.current")).toHaveText("Code");
  const editor = page.locator(".cm-content");
  // Taps only move the cursor until the keyboard's asked for.
  await expect(editor).toHaveAttribute("inputmode", "none");
  await page.getByRole("button", { name: "Type" }).tap();
  await expect(editor).toHaveAttribute("inputmode", "text");
  await expect(editor).toBeFocused();
  await expect(page.locator(".keyboard")).toHaveCount(0);
  await page.getByRole("button", { name: "Hide keyboard" }).tap();
  await expect(editor).toHaveAttribute("inputmode", "none");
  await page.close();
});

test("says quietly why the language server can't start, and still runs the code", async () => {
  const root = join(CODING_HOME, "data", "coding", "python");
  mkdirSync(root, { recursive: true });
  const fails = join(root, FAKE_LSP_FAILS);
  writeFileSync(fails, "");
  // So the server kept for the editor that went is stopped, and the next one starts afresh.
  expect((await phone.request.post("/api/lsp/restart")).ok()).toBe(true);
  const page = await context.newPage();
  const attempts: string[] = [];
  page.on("websocket", (socket) => {
    if (socket.url().includes("/api/coding/lsp/")) attempts.push(socket.url());
  });
  try {
    // The page's clock, to move it on rather than wait to see nothing more is tried.
    await page.clock.install();
    await page.goto(phone.url());
    await expect(page.locator(".step.current")).toHaveText("Code");
    const note = page.locator(".lsp-unavailable");
    await expect(note).toContainText("Completions and error checks are unavailable", {
      timeout: 15_000,
    });
    // Rust says how a process ended as "exit status" on Unix and "exit code" on Windows.
    await expect(note).toContainText(/stopped \(exit (status|code): 1\)/);
    await expect(note).toContainText("told to fail as it starts");
    await expect(note).toContainText("for the Coding track. Then try again.");
    await expect(page.locator(".status-line")).toContainText("no checks");
    // It isn't tried again on its own, as it would only fail the same way, however long it's
    // left: a minute is twice the longest the app waits between tries.
    await page.clock.runFor(60_000);
    expect(attempts).toHaveLength(1);

    // The code still runs without it.
    await page.getByRole("button", { name: "Run examples" }).tap();
    await expect(page.getByRole("region", { name: "Examples run" })).toContainText(
      "examples right",
      { timeout: 20_000 },
    );

    // Once it can start, trying again connects to it.
    rmSync(fails);
    await note.getByRole("button", { name: "Try again" }).tap();
    await expect(note).toHaveCount(0);
    await expect(page.locator(".status-line")).toContainText(/no errors|\d+ (error|warning)/, {
      timeout: 15_000,
    });
    expect(attempts).toHaveLength(2);
  } finally {
    rmSync(fails, { force: true });
    await page.close();
  }
});

test("submits, shows a small input it fails on, then passes and is reviewed", async () => {
  // Printing more than is kept of a run's output, it's said so, rather than shown as a mismatch.
  await writeCode("print('a' * 100000)\n");
  await phone.reload();
  await phone.getByRole("button", { name: "Submit" }).tap();
  const cutOff = phone.getByRole("region", { name: "Test results" });
  await expect(cutOff).toContainText("Example 1: Output cut off", { timeout: 30_000 });
  await expect(cutOff).toContainText(
    "It printed more than 64 KiB, where output is cut off, so it couldn't be compared with the expected output.",
  );
  await expect(cutOff.getByRole("heading", { name: "Got" })).toHaveCount(0);
  await expect(cutOff).not.toContainText("aaaa");

  // Right on both examples, but it takes the word that first appeared earliest, rather than
  // the first to appear again.
  await writeCode(
    "import sys\nwords = sys.stdin.read().split()\nrepeated = [w for w in words if words.count(w) > 1]\nprint(repeated[0] if repeated else 'none')\n",
  );
  await phone.reload();
  await phone.getByRole("button", { name: "Submit" }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Test");
  const results = phone.getByRole("region", { name: "Test results" });
  await expect(results).toContainText("then went wrong", { timeout: 30_000 });
  await expect(results).toContainText("A random input of size");
  const input = await results.locator(".coding-io").first().innerText();
  expect(input.trim().split(/\s+/).length).toBeLessThanOrEqual(12);

  // The tutor gives a hint, through the stand-in model, about where things are.
  await phone.getByRole("button", { name: "Back to the code" }).tap();
  await phone.getByRole("button", { name: "Tutor" }).tap();
  const tutor = phone.getByRole("dialog", { name: "Tutor" });
  await expect(tutor).toContainText("Ask for a hint");
  const question = tutor.getByPlaceholder("Or type a question");
  await question.fill("Why does it fail?");
  await question.press("Enter");
  await expect(tutor.locator(".turn.coach")).toContainText('You asked "Why does it fail?"', {
    timeout: 15_000,
  });
  await tutor.getByRole("button", { name: "Close" }).tap();

  await writeCode(
    "import sys\nseen = set()\nfor word in sys.stdin.read().split():\n    if word in seen:\n        print(word)\n        break\n    seen.add(word)\nelse:\n    print('none')\n",
  );
  await phone.reload();
  await phone.getByRole("button", { name: "Submit" }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Review", { timeout: 30_000 });
  await expect(phone.locator(".learn-verdict")).toHaveText("Solved: it passed every test.");
  await expect(phone.getByRole("region", { name: "Approach" })).toContainText("set");
  // Two submissions and a hint, so it's suggested it was hard.
  await expect(phone.locator(".rating.suggested")).toHaveText("Hard");

  // Explained aloud, the solution is marked against the approach, with the code it explains,
  // and for how clearly it's put; its mistakes are kept, and the attempt is still the rating.
  await phone.getByRole("button", { name: "Explain your solution aloud, to be marked" }).tap();
  const explain = phone.getByRole("region", { name: "Explain it aloud" });
  await holdToTalk(
    phone,
    explain.getByRole("button", { name: "Hold to explain" }),
    "each word goes in a set and the first one seen twice is printed",
    () => expect(explain.locator(".dictate-hearing")).toContainText("printed"),
  );
  await explain.getByRole("button", { name: "Mark my explanation" }).tap();
  const marked = phone.getByRole("region", { name: "Marked" });
  await expect(marked.getByRole("region", { name: "Clarity" })).toContainText("75%");
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { item: string; source: string; detail: string }[];
  };
  expect(
    log.mistakes.some((m) => m.item === "sample/first-repeat" && m.detail.includes("seen twice")),
  ).toBe(true);
  await phone.getByRole("button", { name: "Good" }).tap();
  await expect(phone.getByRole("region", { name: "Done" })).toContainText("comes back in about");
  await expect.poll(() => overviewStatus("sample/first-repeat")).toBe("done");
});

/**
 * How well an element's text stands out from its fill, as WCAG works it out, in light and dark
 * mode: the lower of the two. A faded element counts as not standing out at all.
 */
async function contrast(locator: Locator): Promise<number> {
  const ratios: number[] = [];
  for (const colorScheme of ["light", "dark"] as const) {
    await phone.emulateMedia({ colorScheme });
    ratios.push(
      await locator.evaluate((element) => {
        const style = getComputedStyle(element);
        if (style.opacity !== "1") return 0;
        const luminance = (colour: string) => {
          const [r = 0, g = 0, b = 0] = (colour.match(/[\d.]+/g) ?? []).map(Number);
          const linear = (c: number) =>
            c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4;
          return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
        };
        const text = luminance(style.color);
        const fill = luminance(style.backgroundColor);
        return (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05);
      }),
    );
  }
  await phone.emulateMedia({ colorScheme: null });
  return Math.min(...ratios);
}

/** Solves a problem as far as the server's concerned, rated good, so it comes back for review. */
async function solvedBefore(key: string): Promise<void> {
  const item = `/api/coding/items/${key}`;
  expect((await phone.request.post(`${item}/open`)).ok()).toBe(true);
  const finished = await phone.request.post(`${item}/finish`, {
    data: { id: crypto.randomUUID(), rating: "good" },
  });
  expect(finished.ok()).toBe(true);
}

test("comes back as a twist on it, posed once, answered and marked", async () => {
  await phone.goto("/coding/sample/first-repeat");
  await expect(phone.locator(".step")).toHaveText(["Twist"]);
  const twist = phone.getByRole("region", { name: "Twist" });
  await expect(twist).toContainText("A new constraint");
  await expect(twist).toContainText("Twist 1, a new constraint: now the input streams in");
  // The step it's at, and a button that can't be pressed yet, are readable in either mode.
  expect(await contrast(phone.locator(".step.current"))).toBeGreaterThanOrEqual(4.5);
  const mark = phone.getByRole("button", { name: "Mark my answer" });
  await expect(mark).toBeDisabled();
  expect(await contrast(mark)).toBeGreaterThanOrEqual(4.5);
  // Kept for the review, so a reload shows the same one, with the answer as far as it got.
  const answer = phone.getByLabel("How would you change your approach, and what would it cost?");
  await answer.fill("Keep the set, and stop at the first repeat");
  await expect
    .poll(() =>
      phone.evaluate(() =>
        localStorage.getItem("workshop:unsaved:coding-session:sample/first-repeat"),
      ),
    )
    .toBeNull();
  await phone.reload();
  await expect(twist).toContainText("Twist 1, a new constraint");
  await expect(answer).toHaveValue("Keep the set, and stop at the first repeat");

  // The code can be changed too, and goes to the grader with the answer.
  await phone.getByRole("button", { name: "Change your code too" }).tap();
  await expect(
    phone.getByRole("region", { name: "Your code" }).locator(".cm-content"),
  ).toContainText("seen.add(word)");
  await phone.getByRole("button", { name: "Mark my answer" }).tap();

  // The grader's mark is the review's rating: partly right, so it comes back.
  await expect(phone.getByRole("region", { name: "Done" })).toContainText("comes back in about", {
    timeout: 15_000,
  });
  await expect(phone.getByRole("region", { name: "Marked" })).toContainText("70%");
  // Done, the steps can't be gone back to, and the one it was at is still readable.
  await expect(phone.locator(".step.current")).toBeDisabled();
  expect(await contrast(phone.locator(".step.current"))).toBeGreaterThanOrEqual(4.5);
  await expect(phone.getByRole("region", { name: "A good answer" })).toContainText("as it arrives");
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { item: string; detail: string }[];
  };
  expect(
    log.mistakes.some(
      (m) => m.item === "sample/first-repeat" && m.detail.includes("Unclear on memory"),
    ),
  ).toBe(true);
  await expect.poll(() => overviewStatus("sample/first-repeat")).toBe("done");
});

test("retires a problem whose twist is answered in full, and brings it back from the list", async () => {
  await phone.goto("/coding/sample/first-repeat");
  // The next review's twist is another kind.
  const twist = phone.getByRole("region", { name: "Twist" });
  await expect(twist).toContainText("Twist 2, a far larger scale");
  await phone.getByRole("button", { name: "Explain your answer aloud, to be marked" }).tap();
  const explain = phone.getByRole("region", { name: "Explain it aloud" });
  await holdToTalk(
    phone,
    explain.getByRole("button", { name: "Hold to explain" }),
    "I keep what's been seen as it arrives and stop at the first repeat",
    () => expect(explain.locator(".dictate-hearing")).toContainText("first repeat"),
  );
  await explain.getByRole("button", { name: "Mark my explanation" }).tap();
  await expect(phone.getByRole("region", { name: "Done" })).toContainText("Retired", {
    timeout: 15_000,
  });
  await expect(phone.getByRole("region", { name: "Marked" })).toContainText("100%");
  await expect(phone.getByRole("region", { name: "Clarity" })).toContainText("80%");

  await phone.getByRole("button", { name: "More coding" }).tap();
  const retired = phone.getByRole("region", { name: "Retired" });
  await expect(retired).toContainText("The first word to repeat");
  await expect(phone.locator(".coding-item", { hasText: "The first word to repeat" })).toHaveCount(
    0,
  );
  await retired.getByRole("button", { name: "Bring back" }).tap();
  await expect(retired).toHaveCount(0);
  await expect(
    phone.locator(".coding-item", { hasText: "The first word to repeat" }),
  ).toContainText("Problem · Due");
});

test("recalls the approach instead when no twist can be posed, and retires it rated easy", async () => {
  await solvedBefore("sample/rising-run");
  await phone.goto("/coding/sample/rising-run");
  await expect(phone.locator(".step")).toHaveText(["Plan", "Review"]);
  // It says why it's a recall.
  await expect(phone.locator(".banner", { hasText: "pose a twist" })).toContainText(
    "The tutor couldn't pose a twist (",
  );
  await expect(phone.locator(".banner", { hasText: "pose a twist" })).toContainText(
    "so recall how to solve it instead.",
  );
  const plan = phone.getByLabel("From memory: how would you solve it?");
  await plan.fill("Walk once, keeping the length of the rise so far");
  // The grader checks it first, if asked.
  await phone.getByRole("button", { name: "Check my plan" }).tap();
  await expect(phone.getByRole("region", { name: "Marked" })).toContainText("50%");
  // Or it's explained aloud, and marked for how clearly it's put too.
  await phone.getByRole("button", { name: "Explain your plan aloud, to be marked" }).tap();
  const explain = phone.getByRole("region", { name: "Explain it aloud" });
  await expect(explain).toContainText("From memory, explain how you'd solve it");
  await holdToTalk(
    phone,
    explain.getByRole("button", { name: "Hold to explain" }),
    "I walk once and reset the run when it falls",
    () => expect(explain.locator(".dictate-hearing")).toContainText("falls"),
  );
  await explain.getByRole("button", { name: "Mark my explanation" }).tap();
  await expect(phone.getByRole("region", { name: "Clarity" })).toContainText("75%");
  await phone.getByRole("button", { name: "Compare with the approach" }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Review");
  await expect(phone.getByRole("region", { name: "Your plan" })).toContainText(
    "keeping the length of the rise",
  );
  await expect(phone.getByRole("region", { name: "Approach" })).toContainText("Walk the readings");
  await expect(phone.locator(".rating.suggested")).toHaveCount(0);
  await expect(phone.getByText("Easy retires it")).toBeVisible();
  await phone.getByRole("button", { name: "Easy" }).tap();
  await expect(phone.getByRole("region", { name: "Done" })).toContainText("Retired");
  await expect.poll(() => overviewStatus("sample/rising-run")).toBe("retired");
  await phone.getByRole("button", { name: "More coding" }).tap();
  await expect(phone.getByRole("region", { name: "Retired" })).toContainText("Longest rising run");
});

test("recalls the approach instead when the server can't be reached for a twist", async ({
  browser,
}) => {
  await solvedBefore("sample/stair-ways");
  // A phone of its own, without the service worker, which in WebKit would keep the request
  // from being cut off below.
  const own = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${CODING_PORT}`,
    serviceWorkers: "block",
  });
  const page = await own.newPage();
  await page.goto(`/?token=${token()}`);
  // The connection drops just as the twist is asked for.
  await page.route("**/api/coding/items/sample/stair-ways/twist", (route) =>
    route.abort("internetdisconnected"),
  );
  await page.goto("/coding/sample/stair-ways");
  await expect(page.locator(".step")).toHaveText(["Plan", "Review"]);
  await expect(page.locator(".banner", { hasText: "pose a twist" })).toContainText(
    "The server can't be reached to pose a twist, so recall how to solve it instead.",
  );
  await page.unroute("**/api/coding/items/sample/stair-ways/twist");
  await expect(page.getByLabel("From memory: how would you solve it?")).toBeVisible();
  // Saved as a recall, and kept on the phone only until the server's heard of it.
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("workshop:unsaved:coding-session:sample/stair-ways"),
      ),
    )
    .toBeNull();
  const response = await page.request.get("/api/coding?utc_offset=0");
  const { items } = (await response.json()) as { items: { key: string; mode: string }[] };
  expect(items.find((item) => item.key === "sample/stair-ways")?.mode).toBe("recall");
  await own.close();
});

test("reads and solves in Haskell, with its highlighting and language server", async () => {
  const page = await context.newPage();
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  try {
    // Code to read, highlighted as Haskell, and checked on the phone.
    await page.goto("/coding/sample/printing-your-own-type");
    const prompt = page.locator(".learn-prompt");
    await expect(prompt.locator(".syntax-keyword").first()).toHaveText("data");
    await expect(prompt).toContainText("main = print Red");
    await page.getByRole("button", { name: /Colour has none/ }).tap();
    await expect(page.locator(".learn-verdict")).toHaveText("Right");
    await page.getByRole("button", { name: "Got it" }).tap();
    await expect(page).toHaveURL(/\/coding$/);

    // A problem, solved in Haskell, its first language.
    await page.locator(".coding-item", { hasText: "Lowest balance" }).tap();
    await expect(page.locator(".step.current")).toHaveText("Understand");
    await page.getByLabel("What should it print?").fill("-3");
    await page.getByRole("button", { name: "Check" }).tap();
    await expect(page.locator(".learn-verdict")).toHaveText("Right");
    await page.getByRole("button", { name: "Next: plan" }).tap();
    await page.getByLabel("How will you solve it?").fill("The smallest of the running totals.");
    await page.getByRole("button", { name: "Next: code" }).tap();
    await expect(page.locator(".step.current")).toHaveText("Code");
    const editor = page.locator(".cm-content");
    await expect(editor).toContainText("lowestBalance changes = undefined");
    // In the editor's Haskell mode.
    await expect(editor.locator(".syntax-keyword", { hasText: "where" })).toBeVisible();
    // Haskell's language server, started for Haskell's drafts, which it sees as a project of
    // their own.
    await expect
      .poll(() => sockets.some((url) => url.includes("/api/coding/lsp/haskell")))
      .toBe(true);
    expect(
      readFileSync(join(CODING_HOME, "data", "coding", "haskell", "hie.yaml"), "utf8"),
    ).toContain('"-hide-all-packages"');
    await page.getByRole("button", { name: "Type" }).tap();
    const keyboard = page.locator(".keyboard");
    const key = (name: string) => keyboard.getByRole("button", { name, exact: true });
    await key("g").tap();
    await key("g").tap();
    await key("Shift").tap();
    await key("O").tap();
    for (const ch of "oops") await key(ch).tap();
    await key("Escape").tap();
    await expect(page.locator(".status-line")).toContainText("1 error", { timeout: 15_000 });
    await key("u").tap();
    await expect(page.locator(".status-line")).toContainText("no errors", { timeout: 15_000 });
  } finally {
    await page.close();
  }
});

test("says clearly that problems need the server, while code to read works offline", async () => {
  // The app is kept on the phone by its service worker, once that's in charge of the page.
  await phone.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await phone.reload();
  await expect
    .poll(() => phone.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await setOffline(context, true);
  await phone.goto("/coding");
  await expect(phone.locator(".banner.offline")).toContainText("Coding problems need the server");
  await phone.locator(".coding-item", { hasText: "A reference into a growing vector" }).tap();
  await phone.getByRole("button", { name: /push_back can move the elements to new memory/ }).tap();
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await phone.getByRole("button", { name: "Got it" }).tap();
  await expect(phone.locator(".learn-sync")).toContainText("Offline · 1 to sync");

  await phone.goto("/coding/sample/islands");
  await expect(phone.locator(".error-text")).toContainText("need the server");
  await setOffline(context, false);
  await phone.getByRole("button", { name: "Try again" }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Understand");
  await expect(phone.locator(".learn-sync")).toHaveCount(0);
});

test("saves coding problems for offline use, works through one offline, and syncs back", async () => {
  await phone.goto("/coding");
  await phone.getByRole("button", { name: "Save problems for offline" }).tap();
  await expect(phone.getByRole("button", { name: "Refresh offline copy" })).toBeVisible({
    timeout: 15_000,
  });

  await setOffline(context, true);
  await phone.reload();
  await expect(phone.locator(".banner.offline")).toContainText("Saved coding problems open");

  // Open a cached problem offline, edit the plan, reconnect, edit again online (verifying no
  // false version-conflict banner), and finish cleanly.
  await phone.locator(".coding-item", { hasText: "Count the islands" }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Understand");
  await phone.getByRole("button", { name: "Skip" }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Plan");
  await phone.getByLabel(/How will you solve it/).fill("BFS over the grid cells.");
  // Wait for the debounced offline save to queue `session_updated` in the outbox.
  await expect
    .poll(() =>
      phone.evaluate(() => localStorage.getItem("workshop:outbox")?.includes("BFS over the grid")),
    )
    .toBe(true);

  // Reconnect mid-session so the offline open + update flush via the outbox, then edit again
  // online: the saver must adopt the outbox's applied version without triggering a 409 banner.
  await setOffline(context, false);
  await expect
    .poll(
      () =>
        phone.evaluate(() => {
          const raw = localStorage.getItem("workshop:outbox");
          return raw ? (JSON.parse(raw) as unknown[]).length : 0;
        }),
      { timeout: 15_000 },
    )
    .toBe(0);
  await phone
    .getByLabel(/How will you solve it/)
    .fill("BFS over the grid cells, marking visited land.");
  await phone.getByRole("button", { name: "Next: code" }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Code");
  await expect(phone.getByText(/edited on another device/i)).toHaveCount(0);

  // Go back offline, move to Review and finish offline, then sync back online.
  await setOffline(context, true);
  await phone.reload();
  await expect(phone.getByRole("button", { name: "Review approach" })).toBeVisible();
  await phone.getByRole("button", { name: "Review approach" }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Review");
  await expect(phone.getByRole("region", { name: "Approach" })).toBeVisible();
  await phone.getByRole("button", { name: "Good" }).tap();
  await expect(phone.getByRole("button", { name: "More coding" })).toBeVisible();

  await setOffline(context, false);
  await expect
    .poll(
      async () => {
        const res = await phone.request.get("/api/coding?utc_offset=0");
        const data = (await res.json()) as { items: { key: string; status: string }[] };
        return data.items.find((i) => i.key === "sample/islands")?.status;
      },
      { timeout: 15_000 },
    )
    .toBe("done");
});

/** A file of the sample pack's text buffer, a problem in parts in API mode. */
const textBuffer = (file: string) =>
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "packs",
      "sample",
      "items",
      "stateful",
      "text-buffer",
      file,
    ),
    "utf8",
  );

/** Whether the page scrolls sideways, which nothing on a phone should make it. */
const scrollsSideways = () =>
  phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test("works through a problem in parts, keeping the code from one part to the next", async () => {
  await phone.goto("/coding/sample/text-buffer");
  const bar = phone.locator(".coding-part-bar");
  await expect(bar).toHaveText("Part 1 of 3");
  // In API mode, an example is calls, and understanding it is saying what the last returns.
  const example = phone.getByRole("region", { name: "Example 1" });
  await expect(example).toContainText('insert(" world")');
  await phone.getByLabel(/What does text\(\) return/).fill("hello wo");
  await phone.getByRole("button", { name: "Check" }).tap();
  await expect(phone.getByRole("region", { name: "Answer" })).toContainText("Right");
  expect(await scrollsSideways()).toBe(false);
  await phone.getByRole("button", { name: "Next: plan" }).tap();
  await phone.getByLabel("How will you solve it?").fill("A list of characters");
  await phone.getByRole("button", { name: "Next: code" }).tap();
  // The starter is the class to fill in.
  const editor = phone.locator(".cm-content");
  await expect(editor).toContainText("class TextBuffer");
  await expect(editor).toContainText("def delete(self, count: int) -> None:");
  expect(await scrollsSideways()).toBe(false);

  const item = "/api/coding/items/sample/text-buffer";
  await writeCode(textBuffer("reference.py"), item);
  await phone.reload();
  await expect(editor).toContainText("self.chars.extend(text)");
  await phone.getByRole("button", { name: "Submit" }).tap();
  // Passing part 1 shows part 2, new, with part 1 folded away and the code kept.
  await expect(bar).toHaveText("Part 2 of 3", { timeout: 30_000 });
  await expect(phone.getByRole("status").filter({ hasText: "Part 1 passed" })).toBeVisible();
  await expect(phone.locator(".step.current")).toHaveText("Understand");
  const fresh = phone.getByRole("region", { name: "Part 2, new" });
  await expect(fresh).toContainText("undo()");
  await expect(phone.locator(".coding-parts details summary")).toHaveText(["Part 1"]);
  expect(await scrollsSideways()).toBe(false);

  // Coming back, it's where it was left: part 2, with part 1's code.
  await phone.reload();
  await expect(bar).toHaveText("Part 2 of 3");
  await phone.getByRole("button", { name: "Skip" }).tap();
  await expect(phone.getByLabel(/change your code for part 2/)).toBeVisible();
  await phone.getByLabel(/change your code for part 2/).fill("A stack of changes to reverse");
  await phone.getByRole("button", { name: "Next: code" }).tap();
  await expect(editor).toContainText("self.chars.extend(text)");
  await expect(editor).not.toContainText("def undo");
  // Part 1's example still passes; part 2's doesn't yet, and says what came back.
  await phone.getByRole("button", { name: "Run examples" }).tap();
  const results = phone.getByRole("region", { name: "Examples run" });
  await expect(results).toContainText("1 of 2 examples right", { timeout: 20_000 });
  await expect(results).toContainText("Part 2's example 1: Crashed");
  await expect(results).toContainText("undo()  ✗ stopped here");
  await expect(results).toContainText("TextBuffer has no undo to call");
  expect(await scrollsSideways()).toBe(false);
  // A hint for the part being worked on.
  await phone.getByRole("button", { name: "A hint" }).tap();
  await expect(phone.getByRole("list", { name: "Hints" })).toContainText("reverse it");
});
