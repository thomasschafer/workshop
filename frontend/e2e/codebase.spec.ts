import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import { CODEBASE_HOME, CODEBASE_PORT } from "./fixture";
import { holdToTalk, installSimulatedSpeech } from "./speech";

// One learner on one phone, working in the sample pack's codebases: fixing a bug a file at a
// time, refactoring then extending a project in parts, and reviewing a change. The model and
// the language server are the tests' stand-ins.
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;

const token = () => readFileSync(join(CODEBASE_HOME, "config", "token"), "utf8").trim();
const SAMPLE = resolve(import.meta.dirname, "../../packs/sample/items/working-in-code");
const sample = (path: string) => readFileSync(join(SAMPLE, path), "utf8");

interface ProjectFile {
  path: string;
  code: { text: string; version: string };
}

/** Saves a file of a project on the server, as typing it in full would. */
async function writeFile(item: string, path: string, text: string): Promise<void> {
  const opened = await phone.request.post(`/api/coding/items/sample/${item}/open`);
  expect(opened.ok()).toBe(true);
  const { project } = (await opened.json()) as { project: { files: ProjectFile[] } };
  const file = project.files.find((f) => f.path === path);
  if (!file) throw new Error(`there's no ${path} in ${item}`);
  const saved = await phone.request.put(`/api/coding/items/sample/${item}/files/${path}`, {
    data: { text, version: file.code.version },
  });
  expect(saved.ok()).toBe(true);
}

/** A file of a project as the server has it. */
async function serverText(item: string, path: string): Promise<string> {
  const opened = await phone.request.post(`/api/coding/items/sample/${item}/open`);
  const { project } = (await opened.json()) as { project: { files: ProjectFile[] } };
  return project.files.find((f) => f.path === path)?.code.text ?? "";
}

/** Whether the page is no wider than the phone, so nothing scrolls sideways. */
async function fitsTheScreen(): Promise<void> {
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${CODEBASE_PORT}`,
    // Work in a codebase needs the server, and requests are only seen by a test's routes when
    // no service worker makes them.
    serviceWorkers: "block",
  });
  phone = await context.newPage();
  await phone.addInitScript(installSimulatedSpeech, 20);
  await phone.goto(`/?token=${token()}`);
});

test.afterAll(async () => {
  await context?.close();
});

test("lists work in a codebase in the Coding track, by its task", async () => {
  await phone.goto("/coding");
  await expect(
    phone.locator(".coding-item", { hasText: "Word counts that are one too many" }),
  ).toContainText("Fix a bug · New");
  await expect(phone.locator(".coding-item", { hasText: "Reviewing loan renewals" })).toContainText(
    "Review a change · New",
  );
  await expect(phone.locator(".coding-item", { hasText: "Testing habit streaks" })).toContainText(
    "Refactor and extend · New",
  );
});

test("fixes a bug a file at a time, with its tests to read and run", async () => {
  await phone.locator(".coding-item", { hasText: "Word counts that are one too many" }).tap();
  await expect(phone).toHaveURL(/\/coding\/sample\/word-counts$/);
  // There's code to read rather than an example to work out, so it starts with the code, and
  // the diagnosis is written beside it.
  await expect(phone.locator(".step")).toHaveText(["Code", "Test", "Review"]);
  await expect(phone.locator(".step.current")).toHaveText("Code");
  await phone.getByText("Diagnosis", { exact: true }).tap();
  await phone.getByLabel("What's wrong, and why").fill("Something counts a blank word.");
  await phone.getByText("Diagnosis", { exact: true }).tap();

  const switcher = phone.getByRole("button", { name: /Switch file/ });
  await expect(switcher).toContainText("report.py");
  await fitsTheScreen();
  await switcher.tap();
  const files = phone.getByRole("list", { name: "Files" });
  await expect(files.getByRole("button")).toHaveText([
    "report.py",
    "stats.py",
    /test_stats\.py\s*tests · read-only/,
    "words.py",
  ]);
  // Searching across the files goes to the line found.
  await phone.getByPlaceholder("Search the files").fill("_BETWEEN.split");
  const found = phone.getByRole("list", { name: "Found" }).getByRole("button");
  await expect(found).toHaveCount(1);
  await expect(found).toContainText("words.py:11");
  await found.tap();
  await expect(switcher).toContainText("words.py");
  await expect(phone.locator(".cm-content")).toContainText("def split_words");
  await expect(phone.locator(".cm-activeLine")).toContainText("_BETWEEN.split");

  // Tests are the problem's own: read, run, never changed.
  await switcher.tap();
  await files.getByRole("button", { name: /test_stats\.py/ }).tap();
  await expect(phone.locator(".cm-content")).toHaveAttribute("aria-readonly", "true");
  await switcher.tap();
  await files.getByRole("button", { name: /^words\.py/ }).tap();
  await expect(phone.locator(".cm-content")).not.toHaveAttribute("aria-readonly", "true");

  // A file added opens, and is marked as new.
  await switcher.tap();
  await phone.getByRole("button", { name: "Add a file" }).tap();
  await phone.getByPlaceholder("clock.py").fill("notes.py");
  await phone.getByRole("button", { name: "Add", exact: true }).tap();
  await expect(switcher).toContainText(/notes\.py\s*new/);
  await phone.locator(".cm-content").tap();
  await phone.keyboard.type("# Blank words come from re.split");
  await expect.poll(() => serverText("word-counts", "notes.py")).toContain("re.split");
  await switcher.tap();
  await files.getByRole("button", { name: /^words\.py/ }).tap();
  await expect(phone.locator(".cm-content")).toContainText("def split_words");

  // Which file is open is kept, so it's open again after a reload.
  await expect
    .poll(async () => {
      const opened = await (
        await phone.request.post("/api/coding/items/sample/word-counts/open")
      ).json();
      return (opened as { session: { file: string | null } }).session.file;
    })
    .toBe("words.py");
  await phone.reload();
  await expect(phone.getByRole("button", { name: /Switch file/ })).toContainText("words.py");

  // The project's own tests pass as it's given, and the hidden ones find the bug.
  await phone.getByRole("button", { name: "Run tests" }).tap();
  const results = phone.getByRole("region", { name: "Examples run" });
  await expect(results).toContainText("5 of 5 tests pass");
  await expect(results).toContainText("splits on spaces and punctuation: passes");
  await results.getByRole("button", { name: "Close" }).tap();
  await phone.getByRole("button", { name: "Submit" }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Test");
  const failure = phone.getByRole("region", { name: "Test results" });
  await expect(failure).toContainText("ends with a full stop: fails");
  await expect(failure).toContainText("A hidden test, in test_punctuation.py");
  await expect(failure).toContainText("AssertionError");
  await fitsTheScreen();

  // Fixed, and marked as changed in the switcher.
  await writeFile("word-counts", "words.py", sample("word-counts/fixed/words.py"));
  await phone.getByRole("button", { name: "Back to the code" }).tap();
  // Back at the code, the file added and what was typed in it are as they were.
  await expect(phone.getByRole("button", { name: /Switch file/ })).toContainText("words.py");
  await phone.getByRole("button", { name: /Switch file/ }).tap();
  await files.getByRole("button", { name: /^notes\.py/ }).tap();
  await expect(phone.locator(".cm-content")).toContainText("re.split");
  await phone.locator(".cm-content").tap();
  await phone.keyboard.press("End");
  await phone.keyboard.type(" at the ends");
  await expect.poll(() => serverText("word-counts", "notes.py")).toContain("at the ends");
  await expect(phone.getByText("The code changed elsewhere.")).toHaveCount(0);
  await phone.reload();
  // The fix, written on the server, is marked as a change, as is the file added.
  await expect(phone.getByRole("button", { name: /Switch file/ })).toContainText(/notes\.py\s*new/);
  await phone.getByRole("button", { name: /Switch file/ }).tap();
  await expect(
    phone.getByRole("list", { name: "Files" }).getByRole("button", { name: /^words\.py/ }),
  ).toContainText("changed");
  await phone.getByRole("button", { name: /Switch file/ }).tap();
  await expect(phone.locator(".project-count")).toContainText("2 changed");
  await phone.getByRole("button", { name: "Submit" }).tap();

  // Reviewed against the reference fix, beside the learner's own change.
  await expect(phone.locator(".step.current")).toHaveText("Review");
  await expect(phone.locator(".learn-verdict")).toHaveText("Solved: it passed every test.");
  const yours = phone.getByRole("region", { name: "Your changes" });
  await expect(yours).toContainText("words.py");
  await expect(yours.locator(".diff-line.added")).toContainText([/if word/]);
  await phone.getByText("The reference fix").tap();
  await expect(phone.getByRole("region", { name: "The reference's changes" })).toContainText(
    "words.py",
  );
  await expect(phone.getByRole("region", { name: "Approach" })).toContainText("empty string");
  await fitsTheScreen();
  await phone.getByRole("button", { name: "Good" }).tap();
  await expect(phone.getByRole("region", { name: "Done" })).toContainText("comes back");
});

test("comes back as a recall of what was wrong", async () => {
  // Opened again, it's reviewed by recalling it, as there are no twists on work in a codebase.
  const opened = await phone.request.post("/api/coding/items/sample/word-counts/open");
  const { session } = (await opened.json()) as { session: { mode: string; step: string } };
  expect(session).toMatchObject({ mode: "recall", step: "plan" });
  await phone.goto("/coding/sample/word-counts");
  await expect(phone.getByLabel("From memory: what was wrong")).toBeVisible();
  await expect(phone.locator(".step")).toHaveText(["Plan", "Review"]);
});

test("refactors, then extends, the project kept from one part to the next", async () => {
  await phone.goto("/coding/sample/habit-streaks");
  await expect(phone.locator(".coding-part-bar")).toContainText("Part 1 of 2");
  await expect(phone.locator(".step.current")).toHaveText("Code");
  const switcher = phone.getByRole("button", { name: /Switch file/ });
  await expect(switcher).toContainText("log.py");
  await switcher.tap();
  const files = phone.getByRole("list", { name: "Files" });
  await expect(files.getByRole("button")).toHaveText([
    "log.py",
    /test_tracker\.py\s*tests · read-only/,
    /test_tracker_clock\.py\s*tests · read-only/,
    "tracker.py",
  ]);
  await phone.getByRole("button", { name: /Switch file/ }).tap();

  await writeFile("habit-streaks", "log.py", sample("habit-streaks/clock/solution/log.py"));
  await writeFile("habit-streaks", "tracker.py", sample("habit-streaks/clock/solution/tracker.py"));
  await phone.reload();
  await phone.getByRole("button", { name: "Submit" }).tap();

  // Part 2's tests arrive with it, and the refactored code is kept.
  await expect(phone.locator(".coding-part-bar")).toContainText("Part 2 of 2");
  await expect(phone.locator(".step.current")).toHaveText("Code");
  await phone.locator(".coding-statement.compact > summary").first().tap();
  await expect(phone.getByRole("region", { name: "Part 2, new" })).toContainText("longest");
  await phone.locator(".coding-statement.compact > summary").first().tap();
  await phone.getByRole("button", { name: /Switch file/ }).tap();
  await expect(
    phone.getByRole("list", { name: "Files" }).getByRole("button", { name: /test_longest\.py/ }),
  ).toBeVisible();
  await phone
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: /^tracker\.py/ })
    .tap();
  await expect(phone.locator(".cm-content")).toContainText("today=datetime.date.today");
  await phone.getByRole("button", { name: "Run tests" }).tap();
  const results = phone.getByRole("region", { name: "Examples run" });
  await expect(results).toContainText("longest streak ever: fails");
  await expect(results).toContainText("counts back from today: passes");
});

test("reviews a change, commenting on a line and on the whole, saved as it goes", async () => {
  await phone.goto("/coding/sample/loan-renewals");
  await expect(phone.locator(".coding-review-title")).toHaveText("Reviewing loan renewals");
  await expect(phone.getByRole("button", { name: /Switch file/ })).toContainText(
    /loans\.py\s*changed/,
  );
  const diff = phone.getByRole("list", { name: "loans.py, line by line" });
  // Folded around the change, and wrapping rather than scrolling sideways.
  await expect(diff.locator(".diff-fold").first()).toContainText("unchanged");
  await fitsTheScreen();

  await diff.getByRole("button", { name: /^Line 47, added/ }).tap();
  await phone.getByLabel("Comment on line 47").fill("Off by one: this allows a third renewal.");
  await phone.getByRole("button", { name: "Add", exact: true }).tap();
  await expect(diff.locator(".diff-comment")).toContainText("allows a third renewal");

  // A comment on the whole change, dictated.
  await phone.getByRole("button", { name: "Comment on the whole change" }).tap();
  await holdToTalk(
    phone,
    phone.getByRole("button", { name: "Hold to dictate" }),
    "the tests never renew early",
    () => expect(phone.locator(".dictate-hearing")).toContainText("renew early"),
  );
  await expect(phone.getByRole("textbox", { name: "Comment on the whole change" })).toHaveValue(
    "the tests never renew early",
  );
  await phone.getByRole("button", { name: "Add", exact: true }).tap();
  const comments = phone.getByRole("region", { name: "Your comments" });
  await expect(comments.locator(".coding-comment")).toHaveCount(2);
  await expect(comments).toContainText("loans.py, line 47");
  await expect(comments).toContainText("The whole change");

  // Saved as it goes, so it's all there after a reload.
  await expect
    .poll(async () => {
      const opened = await (
        await phone.request.post("/api/coding/items/sample/loan-renewals/open")
      ).json();
      return (opened as { session: { comments: unknown[] } }).session.comments.length;
    })
    .toBe(2);
  await phone.reload();
  await expect(
    phone.getByRole("region", { name: "Your comments" }).locator(".coding-comment"),
  ).toHaveCount(2);

  // A comment is edited where it is, and another on the same line starts empty.
  const diffAgain = phone.getByRole("list", { name: "loans.py, line by line" });
  await diffAgain.locator(".diff-comment").getByRole("button", { name: "Edit" }).tap();
  const editing = phone.getByRole("textbox", { name: "Comment on line 47" });
  await expect(editing).toHaveValue("Off by one: this allows a third renewal.");
  await editing.fill("Off by one: `>` allows a third renewal.");
  await phone.getByRole("button", { name: "Save", exact: true }).tap();
  await expect(diffAgain.locator(".diff-comment")).toContainText("`>` allows");
  await diffAgain.getByRole("button", { name: /^Line 47, added/ }).tap();
  await expect(phone.getByRole("textbox", { name: "Comment on line 47" })).toHaveValue("");
  await phone.getByRole("button", { name: "Cancel" }).tap();

  // A line far from the change, in the whole file, folded away again once it's not shown.
  await phone.getByLabel("Show the whole file").check();
  await diffAgain.getByRole("button", { name: /^Line 25:/ }).tap();
  await phone.getByRole("textbox", { name: "Comment on line 25" }).fill("Fine as it is.");
  await phone.getByRole("button", { name: "Add", exact: true }).tap();
  await phone.getByLabel("Show the whole file").uncheck();
  await expect(diffAgain.locator(".diff-comment", { hasText: "Fine as it is" })).toHaveCount(0);

  // Reading another file, then shown a comment, it's opened, unfolded and brought into view.
  await phone.getByRole("button", { name: /Switch file/ }).tap();
  await phone
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: /catalogue\.py/ })
    .tap();
  await expect(phone.getByRole("list", { name: "catalogue.py, line by line" })).toContainText(
    "class Catalogue",
  );
  const comments2 = phone.getByRole("region", { name: "Your comments" });
  await comments2
    .locator(".coding-comment", { hasText: "Fine as it is" })
    .getByRole("button", { name: "Show" })
    .tap();
  const shown = diffAgain.locator(".diff-comment", { hasText: "Fine as it is" });
  await expect(shown).toBeInViewport();

  // A comment typed but not added yet is part of what's marked.
  const sent: string[] = [];
  phone.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/coding/reviews/")) {
      sent.push(request.postData() ?? "");
    }
  });
  await phone.getByRole("button", { name: "Comment on the whole change" }).tap();
  await phone
    .getByRole("textbox", { name: "Comment on the whole change" })
    .fill("No test renews a book someone's waiting for.");

  // The first reply is lost on the way back; asked again, it's the same marking.
  let lost = false;
  await phone.route("**/coding/reviews/**/submit", async (route) => {
    await route.fetch();
    lost = true;
    // As a proxy might answer when the server's reply doesn't reach it.
    await route.fulfill({ status: 502, contentType: "application/json", body: "{}" });
  });
  await phone.getByRole("button", { name: "Have it marked" }).tap();
  await expect(phone.getByRole("alert")).toBeVisible();
  expect(lost).toBe(true);
  await phone.unroute("**/coding/reviews/**/submit");
  expect(sent.some((body) => body.includes("someone's waiting for"))).toBe(true);
  await phone.getByRole("button", { name: "Have it marked" }).tap();
  // The stand-in grader credits a defect to a comment on a line it covers: two of the three
  // here, and the one missed is kept as a mistake.
  await expect(phone.locator(".marked-score")).toHaveText("67%");
  const wrong = phone.getByRole("region", { name: "What was wrong with it" });
  await expect(wrong.locator(".coding-defect.yes").first()).toContainText("off by one");
  await expect(wrong.locator(".coding-defect.no")).toHaveCount(1);
  await expect(wrong.locator(".coding-defect.no")).toContainText("from today");
  await expect(wrong).toContainText("KeyError");
  await expect(phone.getByRole("region", { name: "Marked" })).toContainText(
    "Missed, kept in your log",
  );
  await fitsTheScreen();
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { suggested: string | null; detail: string }[];
  };
  expect(log.mistakes.filter((m) => m.suggested === "missed-defect")).toHaveLength(1);
});
