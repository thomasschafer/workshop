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
import { holdToTalk, installSimulatedSpeech } from "./speech";

// One learner on one phone, working through a problem of the sample pack's a step at a time,
// with Helix's keybindings and Workshop's own keyboard, from a server that starts with nothing
// done. The model and the language server are the tests' stand-ins.
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;

const token = () => readFileSync(join(CODING_HOME, "config", "token"), "utf8").trim();
const ITEM = "/api/coding/items/sample/first-repeat";

/** Replaces the problem's Python draft on the server, as typing it in full would. */
async function writeCode(text: string): Promise<void> {
  const opened = await phone.request.post(`${ITEM}/open`);
  expect(opened.ok()).toBe(true);
  const { languages } = (await opened.json()) as {
    languages: { id: string; code: { version: string } }[];
  };
  const python = languages.find((l) => l.id === "python");
  if (!python) throw new Error("the problem has no Python draft");
  const saved = await phone.request.put(`${ITEM}/code/python`, {
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
  await expect(coding).toContainText("17 new");
  const next = phone.locator(".continue");
  await expect(next).toContainText("Adding to a global");
  await expect(next).toContainText("Coding · Something new");
  await coding.tap();
  await expect(phone).toHaveURL(/\/coding$/);
  await expect(phone.locator(".coding-item")).toHaveCount(17);
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
  await expect
    .poll(() => overviewStatus("sample/negative-division"), { timeout: 10_000 })
    .not.toBe("new");
});

test("retires code to read answered right as too easy, and brings it back from the list", async () => {
  await phone.locator(".coding-item", { hasText: "When a map's closure runs" }).tap();
  await phone.getByLabel("What it prints").fill("start 1 2 3 Some(6)");
  await phone.getByRole("button", { name: "Check" }).tap();
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await expect(phone.getByRole("button", { name: "Got it" })).toBeFocused();
  await phone.getByRole("button", { name: "Too easy: retire it" }).tap();
  await expect(phone).toHaveURL(/\/coding$/);
  await expect.poll(() => overviewStatus("sample/lazy-map")).toBe("retired");
  // Listed with the retired problems, rather than among what's to do.
  const retired = phone.getByRole("region", { name: "Retired" });
  await expect(retired).toContainText("When a map's closure runs");
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

  // Saved as it goes, so a reload, or coming back later, carries on from here.
  await expect
    .poll(async () => {
      const response = await phone.request.get("/api/coding?utc_offset=0");
      const { items } = (await response.json()) as { items: { key: string; step: string }[] };
      return items.find((item) => item.key === "sample/first-repeat")?.step;
    })
    .toBe("plan");
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
    await page.goto(phone.url());
    await expect(page.locator(".step.current")).toHaveText("Code");
    const note = page.locator(".lsp-unavailable");
    await expect(note).toContainText("Completions and error checks are unavailable", {
      timeout: 15_000,
    });
    await expect(note).toContainText("stopped (exit status: 1)");
    await expect(note).toContainText("told to fail as it starts");
    await expect(note).toContainText("for the Coding track. Then try again.");
    await expect(page.locator(".status-line")).toContainText("no checks");
    // It isn't tried again on its own, as it would only fail the same way.
    await page.waitForTimeout(4000);
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
  // Saved as a recall, once the server's heard of it.
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/coding?utc_offset=0");
        const { items } = (await response.json()) as { items: { key: string; mode: string }[] };
        return items.find((item) => item.key === "sample/stair-ways")?.mode;
      },
      { timeout: 15_000 },
    )
    .toBe("recall");
  await own.close();
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
  await context.setOffline(true);
  await phone.goto("/coding");
  await expect(phone.locator(".banner.offline")).toContainText("Coding problems need the server");
  await phone.locator(".coding-item", { hasText: "A reference into a growing vector" }).tap();
  await phone.getByRole("button", { name: /push_back can move the elements to new memory/ }).tap();
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await phone.getByRole("button", { name: "Got it" }).tap();
  await expect(phone.locator(".learn-sync")).toContainText("Offline · 1 to sync");

  await phone.goto("/coding/sample/islands");
  await expect(phone.locator(".error-text")).toContainText("need the server");
  await context.setOffline(false);
  await phone.getByRole("button", { name: "Try again" }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Understand");
  await expect(phone.locator(".learn-sync")).toHaveCount(0);
});
