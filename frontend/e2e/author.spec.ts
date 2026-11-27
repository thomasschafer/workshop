import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import { AUTHOR_HOME, AUTHOR_PORT, UNBRIEFED_DESIGN } from "./fixture";

// The tests share one phone and run in order, from a server whose pack is a git repo of its
// own, with stand-ins for the author's two models.
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;

const token = () => readFileSync(join(AUTHOR_HOME, "config", "token"), "utf8").trim();
const pack = join(AUTHOR_HOME, "pack");

/** The pack repo's commit subjects, newest first. */
function commits(): string[] {
  return execFileSync("git", ["log", "--format=%s"], { cwd: pack, encoding: "utf8" })
    .trim()
    .split("\n");
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${AUTHOR_PORT}`,
  });
  phone = await context.newPage();
  await phone.goto(`/pack?token=${token()}`);
});

test.afterAll(async () => {
  await context?.close();
});

test("tops up the pack, adding what both models agree on and queueing the rest", async () => {
  const author = phone.getByRole("region", { name: "Author" });
  await expect(author).toContainText("writer with fakewriter writes up to 3 items");
  // Why the reviewer is the one it is.
  await expect(author).toContainText(
    "The reviewer is set under [author] in your config, and uses another provider than the writer's.",
  );
  // It's scheduled to run by itself weekly, and has just run, so it's next due in a week.
  const due = await phone.evaluate(() =>
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    }),
  );
  await expect(author).toContainText("Runs by itself every 7 days. Next run: ");
  await expect(author).toContainText(due);
  await author.getByRole("button", { name: "Top up" }).tap();
  const last = phone.getByRole("region", { name: "Last run" });
  await expect(last).toContainText("Last run: 1 item added in commit", { timeout: 30_000 });
  await expect(last).toContainText("1 item waiting for approval");
  expect(commits()[0]).toBe(
    "Add an item from the author: What does finding the largest of n numbers…",
  );
  // Nothing's left uncommitted in the pack.
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: pack, encoding: "utf8" })).toBe("");

  // Its question can be answered for the next run.
  const asks = phone.getByRole("region", { name: "The author asks" });
  await expect(asks).toContainText("Would you like more on sorting?");
  await asks.getByLabel("Your answer").fill("Yes, please");
  await asks.getByRole("button", { name: "Answer" }).tap();
  await expect(phone.getByRole("status")).toContainText("the next run will see your answer");

  // The one they couldn't agree on waits, with what they said.
  const waiting = phone.getByRole("list", { name: "Waiting for approval" }).locator(":scope > li");
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toContainText("A scan of what, and how?");
  await waiting.getByText("The item, and what they said").tap();
  await expect(waiting).toContainText("A scan looks at each item once.");
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  await waiting.getByRole("button", { name: "Approve" }).tap();
  await expect(phone.getByText("Nothing is waiting.")).toBeVisible();
  expect(commits()[0]).toBe("Add an item from the author, approved: What does a scan cost?");
});

test("imports a question into the pack as a draft", async () => {
  const form = phone.getByRole("region", { name: "Add a question" });
  await form.getByLabel("The question").fill("What does a hash table's worst lookup cost?");
  await form.getByLabel("Where it's from (optional)").fill("A friend's quiz");
  await form.getByLabel("What it should become").selectOption("card");
  await form.getByLabel("Hashing").check();
  await form.getByRole("button", { name: "Add as a draft" }).tap();
  await expect(form.getByRole("status")).toContainText(
    "Added as drafts/what-does-a-hash-table-s.md, in commit",
  );
  const drafts = phone.getByRole("list", { name: "Drafts" });
  await expect(drafts).toContainText("A friend's quiz");
  expect(commits()[0]).toBe("Add a draft question: What does a hash table's worst lookup cost?");
});

test("practises the items the author added", async () => {
  await phone.goto("/");
  // The sample pack's heap card waits for its lesson, so it isn't counted as new.
  await expect(phone.locator(".track", { hasText: "Review" })).toContainText("1 lesson · 11 new");
});

test("answers a Teach me lesson request by writing a lesson, revising on audit, and linking the item", async () => {
  // Open Review, skip its existing lesson, and tap "Teach me" on an unlinked card to request a lesson.
  await phone.locator(".track", { hasText: "Review" }).tap();
  await expect(phone).toHaveURL(/\/practice\/review$/);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  const flowCard = phone.locator(".lesson-flow-card");
  await expect(flowCard).toBeVisible();
  await flowCard.getByRole("button", { name: "Not now" }).tap();
  await expect(phone.getByRole("button", { name: "Teach me" })).toBeVisible();
  await phone.getByRole("button", { name: "Teach me" }).tap();
  await expect(phone.locator(".learn-answer")).toContainText("Lesson requested");
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");

  // Packs lists the request under the author; Top up writes a lesson (revised after reviewer audit)
  // with 3 new items and links the requested card to it.
  await phone.goto("/pack");
  const requests = phone.getByRole("list", { name: "Lesson requests" });
  await expect(requests).toBeVisible();

  const author = phone.getByRole("region", { name: "Author" });
  await author.getByRole("button", { name: "Top up" }).tap();
  const last = phone.getByRole("region", { name: "Last run" });
  await expect(last).toContainText("4 items added, 1 item linked in commit", { timeout: 30_000 });
  await expect(phone.getByRole("list", { name: "Lesson requests" })).toHaveCount(0);
  // The lesson file was revised on the reviewer's audit objection and committed cleanly.
  const lessonFile = readFileSync(
    join(pack, "items", "lessons", "sorting-stability", "item.md"),
    "utf8",
  );
  expect(lessonFile).toContain("Merge sort and Timsort are stable");
  // The deck now has the new lesson and the requested card links to it.
  const deck = (await (await phone.request.get("/api/learning/deck?utc_offset=0")).json()) as {
    lessons: { key: string }[];
    items: { key: string; lesson?: string | null }[];
  };
  expect(deck.lessons.some((l) => l.key === "sample/sorting-stability")).toBe(true);
  expect(deck.items.filter((i) => i.lesson === "sample/sorting-stability").length).toBe(4);
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: pack, encoding: "utf8" })).toBe("");
});

test("makes up a brief for a design prompt without one, and keeps it across a reload", async () => {
  const key = `sample/${UNBRIEFED_DESIGN}`;
  await phone.goto(`/design/${key}`);
  await phone.getByRole("button", { name: "Start the session" }).tap();
  const coach = phone.getByRole("region", { name: "Coach" });
  const ask = async (question: string, answers: number) => {
    await coach.getByLabel("Your question").fill(question);
    await coach.getByRole("button", { name: "Ask the coach" }).tap();
    await expect(coach.locator(".design-turn.coach")).toHaveCount(answers);
    return coach.locator(".design-turn.coach").last().innerText();
  };
  // The made-up brief's peak is drawn afresh each time one's made.
  const first = await ask("How many requests at peak?", 1);
  expect(first).toMatch(/^Peak: \d+ requests a second, from 300 clients\.$/);
  // What it says beyond what's asked stays hidden, on the page and from the app.
  await expect(phone.getByText("billing")).toHaveCount(0);
  const sent = await (await phone.request.get(`/api/design/${key}`)).text();
  expect(sent).not.toContain("billing");
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

  // After a reload, the coach answers from the same brief.
  await phone.reload();
  await expect(coach.locator(".design-turn.coach")).toHaveCount(1);
  expect(await ask("And the requests per second again?", 2)).toBe(first);
  // Something the brief doesn't cover is settled, and kept with it.
  await ask("Does each client have quotas?", 3);
  const saved = JSON.parse(
    readFileSync(join(AUTHOR_HOME, "data", "design", "sessions", `${key}.json`), "utf8"),
  ) as { brief: { source: string; text: string; added: string[] } };
  expect(saved.brief.source).toBe("coach");
  expect(saved.brief.text).toContain(first);
  expect(saved.brief.added).toEqual(['It doesn\'t: "Does each client have quotas?"']);
  await phone.getByRole("button", { name: "Stop here for now" }).tap();
  await expect(phone).toHaveURL(/\/design$/);
});
