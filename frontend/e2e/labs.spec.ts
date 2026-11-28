import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import { LAB, LAB_LESSON, LABS_HOME, LABS_PORT } from "./fixture";
import { setOffline } from "./offline";

// A lab of three steps in the Systems track, whose lesson, to be done first, is in the Memory
// track (see createLabsHome). The stand-in grader meets a step when something was recorded for
// it, and the question at the end when the answer says "zero".

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;

const token = () => readFileSync(join(LABS_HOME, "config", "token"), "utf8").trim();

/** Where screenshots go when `LAB_SHOTS` names a directory, to look over by hand. */
const SHOTS = process.env.LAB_SHOTS;

async function shoot(name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await phone.emulateMedia({ colorScheme: scheme });
    await phone.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`), fullPage: true });
  }
  await phone.emulateMedia({ colorScheme: null });
}

interface ServerLab {
  session: { at: number; records: string[]; explanation: string } | null;
}

async function serverLab(): Promise<ServerLab> {
  const response = await phone.request.get(`/api/labs/${LAB}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ServerLab;
}

/** Opens the Systems track's practice screen, synced with the server. */
async function systems() {
  await phone.goto("/practice/pack%3Asystems");
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
}

function labRow() {
  return phone
    .getByRole("region", { name: "Labs" })
    .locator(".lesson-item")
    .filter({ hasText: "Watching page faults happen" });
}

const continueButton = () => phone.locator(".continue");
const aWhile = () => phone.getByRole("switch", { name: /I've got a while/ });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LABS_PORT}`,
  });
  phone = await context.newPage();
  await phone.goto(`/?token=${token()}`);
});

test.afterAll(async () => {
  await context?.close();
});

test("lists a lab in its track, and opens it", async () => {
  await systems();
  await expect(labRow()).toContainText("Not done · ~30 min · Do first: How memory is paged");
  await labRow().tap();
  await expect(phone).toHaveURL(new RegExp(`/labs/${LAB}$`));
  const intro = phone.getByRole("region", { name: "Lab" });
  await expect(intro.getByRole("heading", { name: "Watching page faults happen" })).toBeVisible();
  await expect(intro).toContainText("Lab · about 30 minutes · 3 steps");
  await expect(intro).toContainText("It builds on the lesson How memory is paged");
  // What each step should show is the grader's until it's marked.
  await expect(phone.getByText("About 25,600 minor faults")).toHaveCount(0);
  // Later goes back to the track.
  await phone.getByRole("button", { name: "Later" }).tap();
  await expect(phone).toHaveURL(/\/practice\/pack%3Asystems$/);
});

test("Continue offers a lab only with I've got a while, and only once its lesson is done", async () => {
  await phone.goto("/");
  await expect(continueButton()).toBeVisible();
  await expect(continueButton()).not.toContainText("Watching page faults");
  await aWhile().check();
  // Its lesson isn't done, so there's nothing long to offer.
  await expect(continueButton()).toBeVisible();
  await expect(continueButton()).not.toContainText("Continue · long");
  await expect(continueButton()).not.toContainText("Watching page faults");
  await aWhile().uncheck();

  const done = await phone.request.post("/api/learning/sync?utc_offset=0", {
    data: {
      lesson_completions: [
        {
          id: "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a90",
          lesson: LAB_LESSON,
          completed_at: Date.now(),
          duration_ms: 120_000,
        },
      ],
    },
  });
  expect(done.ok()).toBe(true);
  await phone.reload();
  await expect(continueButton()).toBeVisible();
  await expect(continueButton()).not.toContainText("Watching page faults");
  await aWhile().check();
  await expect(continueButton()).toContainText("Continue · long");
  await expect(continueButton()).toContainText("Watching page faults happen");
  await expect(continueButton()).toContainText("Lab · something new");
  await continueButton().tap();
  await expect(phone).toHaveURL(new RegExp(`/labs/${LAB}$`));
  // With its lesson done, it no longer asks for it first.
  await expect(phone.getByRole("region", { name: "Lab" })).not.toContainText("It builds on");
  await phone.goto("/");
  await aWhile().uncheck();
});

test("works through a lab a step at a time, carrying on after a reload, and marks it", async () => {
  await phone.goto(`/labs/${LAB}`);
  await phone.getByRole("button", { name: "Start the lab" }).tap();
  const setup = phone.getByRole("region", { name: "Setup" });
  await expect(setup).toContainText("A Linux machine where you can run perf");
  await phone.getByRole("button", { name: "Next: step 1" }).tap();

  const step1 = phone.getByRole("region", { name: "Step 1" });
  await expect(
    step1.getByRole("heading", { name: "Step 1 of 3: Count the faults of a fresh allocation" }),
  ).toBeVisible();
  // Its command is shown as code, to copy.
  await expect(step1.locator(".lab-code pre")).toContainText(
    "perf stat -e minor-faults,major-faults ./touch 100",
  );
  await expect(step1.getByRole("button", { name: "Copy" })).toBeVisible();
  // Long output pasted in stays on its lines, without widening the page.
  const output = [
    "$ perf stat -e minor-faults,major-faults ./touch 100",
    " Performance counter stats for './touch 100':",
    `            25,614      minor-faults${" ".repeat(40)}u`,
    "                 0      major-faults",
  ].join("\n");
  await phone.getByLabel("What you ran and saw").fill(output);
  await shoot("lab-step");
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  await phone.getByRole("button", { name: "Next: step 2" }).tap();
  await phone.getByLabel("What you ran and saw").fill("25,602 minor, 0 major again");
  await expect
    .poll(async () => (await serverLab()).session?.records[1])
    .toBe("25,602 minor, 0 major again");

  // Reloaded part-way, it carries on where it was, with everything recorded.
  await phone.reload();
  await expect(
    phone.getByRole("region", { name: "Step 2" }).getByRole("heading", { name: /Run it again/ }),
  ).toBeVisible();
  await expect(phone.getByLabel("What you ran and saw")).toHaveValue("25,602 minor, 0 major again");
  // Earlier steps can be gone back to.
  await phone.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "1" }).tap();
  await expect(phone.getByLabel("What you ran and saw")).toHaveValue(output);
  await phone.getByRole("button", { name: "Next: step 2" }).tap();
  // The third step is left unrecorded.
  await phone.getByRole("button", { name: "Next: step 3" }).tap();
  await phone.getByRole("button", { name: "Next: the question at the end" }).tap();
  const question = phone.getByRole("region", { name: "The question at the end" });
  await expect(question).toContainText("Why are the first run's faults minor rather than major?");
  const finish = phone.getByRole("button", { name: "Finish and mark it" });
  await expect(finish).toBeDisabled();
  await phone
    .getByLabel("Your answer, in your own words")
    .fill("New memory is filled with zero pages, without the disk.");
  await finish.tap();

  // Marked: the score, then each step's expected result beside what was recorded.
  await expect(phone.getByRole("heading", { name: "Marked" })).toBeVisible();
  await expect(phone.locator(".marked-score")).toHaveText("75%");
  const results = phone.locator(".lab-result");
  await expect(results).toHaveCount(4);
  await expect(results.nth(0)).toContainText("Met");
  await expect(results.nth(0)).toContainText("About 25,600 minor faults");
  await expect(results.nth(0).locator(".lab-recorded")).toContainText("25,614      minor-faults");
  await expect(results.nth(2)).toContainText("Not met");
  await expect(results.nth(2)).toContainText("Nothing recorded.");
  await expect(results.nth(2)).toContainText("Some major faults");
  await expect(results.nth(3)).toContainText(
    "pages are filled with zeros without reading the disk",
  );
  await expect(results.nth(3)).toContainText("New memory is filled with zero pages");
  await expect(
    phone.getByRole("region", { name: "Read more" }).getByRole("link", { name: "perf-stat(1)" }),
  ).toHaveAttribute("href", "https://man7.org/linux/man-pages/man1/perf-stat.1.html");
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  await shoot("lab-results");

  // An attempt, with what the grader found in the mistake log, and the lab's over.
  const mistakes = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { item: string; detail: string }[];
  };
  expect(mistakes.mistakes).toContainEqual(
    expect.objectContaining({ item: LAB, detail: "Left a step of the lab unrecorded" }),
  );
  expect((await serverLab()).session).toBeNull();
  await phone.getByRole("button", { name: "Done" }).tap();
  await expect(phone).toHaveURL(/\/practice\/pack%3Asystems$/);
  await expect(labRow()).toContainText("Done · ~30 min");
  // It can be done again, and shows what was recorded last time.
  await labRow().tap();
  await expect(phone.getByText("What you recorded last time")).toBeVisible();
  await expect(phone.getByRole("button", { name: "Start the lab" })).toBeEnabled();
});

test("offline, says a lab needs the server", async () => {
  await systems();
  await setOffline(context, true);
  await phone.reload();
  await expect(phone.getByRole("region", { name: "Labs" })).toContainText(
    "Labs need the server, which can't be reached.",
  );
  await labRow().tap();
  await expect(phone).toHaveURL(new RegExp(`/labs/${LAB}$`));
  await expect(phone.locator(".banner.offline")).toContainText("Labs need the server");
  await setOffline(context, false);
  // Back online, it opens.
  await expect(phone.getByRole("button", { name: "Start the lab" })).toBeEnabled();
});
