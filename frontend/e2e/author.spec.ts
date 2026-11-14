import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import { AUTHOR_HOME, AUTHOR_PORT } from "./fixture";

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
  await expect(phone.locator(".track", { hasText: "Review" })).toContainText("12 new");
});
