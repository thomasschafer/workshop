import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import { LEARNING_HOME, LEARNING_PORT } from "./fixture";
import { holdToTalk, installSimulatedSpeech } from "./speech";

// The tests share one phone and run in order, like one learner using the app, from a server
// that starts with nothing done and the sample pack.
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;

const token = () => readFileSync(join(LEARNING_HOME, "config", "token"), "utf8").trim();

interface Deck {
  items: {
    key: string;
    kind: string;
    prompt: string;
    answer?: number;
    instances?: { prompt: string; answer: number }[];
    tolerance?: { absolute: number; relative: number; factor?: number };
  }[];
  schedules: Record<string, { reviews: number }>;
  flags: Record<string, { note: string | null }>;
}

/** The deck as the server has it now, which is what it's learnt from the attempts it's been sent. */
async function serverDeck(): Promise<Deck> {
  const response = await phone.request.get("/api/learning/deck");
  expect(response.ok()).toBe(true);
  return (await response.json()) as Deck;
}

/** The answer to the question showing, from the deck the phone keeps. */
async function answerShown(on: Page = phone): Promise<string> {
  const shown = (await on.locator(".learn-prompt").innerText()).trim();
  return on.evaluate((prompt) => {
    const saved = JSON.parse(localStorage.getItem("workshop:learning") ?? "null") as {
      deck: Deck;
    };
    for (const item of saved.deck.items) {
      if (
        item.kind === "probability" &&
        item.prompt.replace(/\s+/g, " ") === prompt.replace(/\s+/g, " ")
      ) {
        return String(item.answer);
      }
      const instance = item.instances?.find((i) => i.prompt === prompt);
      if (instance) return String(instance.answer);
    }
    throw new Error(`no item in the deck asks ${JSON.stringify(prompt)}`);
  }, shown);
}

/** How many items the server has a schedule for, as it learns of attempts. */
async function scheduled(kind?: string): Promise<number> {
  const deck = await serverDeck();
  return Object.keys(deck.schedules).filter(
    (key) =>
      kind === undefined || deck.items.some((item) => item.key === key && item.kind === kind),
  ).length;
}

interface SavedRound {
  minutes: number;
  used_ms: number;
  seen_at: number;
  work: string;
}

/**
 * Changes a timed round as the server keeps it, as if time had passed. The round mustn't be
 * open in the app, which would save it again over this.
 */
function changeRound(item: string, change: (round: SavedRound) => void): SavedRound {
  const path = join(LEARNING_HOME, "data", "rounds", "sample", `${item}.json`);
  const round = JSON.parse(readFileSync(path, "utf8")) as SavedRound;
  change(round);
  writeFileSync(path, JSON.stringify(round));
  return round;
}

/** The working of a round under way, as the server has it. */
async function serverWork(item: string): Promise<string | null> {
  const response = await phone.request.post(`/api/rounds/sample/${item}/open`, { data: {} });
  const opened = (await response.json()) as { round: { work: string } | null };
  return opened.round?.work ?? null;
}

async function goHome(): Promise<void> {
  await phone.getByRole("banner").getByRole("button", { name: "Home" }).tap();
  await expect(phone).toHaveURL(/\/$/);
}

async function answer(text: string, on: Page = phone): Promise<void> {
  await on.getByLabel("Your answer").fill(text);
  await on.getByRole("button", { name: "Check" }).tap();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LEARNING_PORT}`,
  });
  phone = await context.newPage();
  await phone.addInitScript(installSimulatedSpeech, 20);
  await phone.goto(`/?token=${token()}`);
});

test.afterAll(async () => {
  await context?.close();
});

test("shows the pack's tracks at home, and continues with something new", async () => {
  await expect(phone.locator(".track")).toHaveCount(7);
  const names = await phone.locator(".track-name").allInnerTexts();
  expect(names).toEqual([
    "Advent of Code",
    "Coding",
    "Probability",
    "System design",
    "Mental maths",
    "Review",
    "Estimation",
  ]);
  // Each has an icon of its own, the pack's track the one its pack.toml chooses.
  const icons = await phone
    .locator(".track .track-icon")
    .evaluateAll((svgs) => svgs.map((svg) => svg.getAttribute("data-icon")));
  expect(icons).toEqual(["star", "code", "dice", "network", "sigma", "history", "approximately"]);
  // Drawn in the theme's accent colour, light or dark, beside the name.
  for (const colorScheme of ["light", "dark"] as const) {
    await phone.emulateMedia({ colorScheme });
    const { icon, accent } = await phone
      .locator(".track .track-icon")
      .first()
      .evaluate((svg) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--accent)";
        document.body.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return { icon: getComputedStyle(svg).color, accent };
      });
    expect(icon).toBe(accent);
  }
  await phone.emulateMedia({ colorScheme: null });
  const iconBox = await phone.locator(".track .track-icon").first().boundingBox();
  const nameBox = await phone.locator(".track-name").first().boundingBox();
  expect(iconBox && nameBox && iconBox.x + iconBox.width < nameBox.x).toBe(true);
  await expect(phone.locator(".track", { hasText: "Review" })).toContainText("10 new");
  // Nothing's due yet, so Continue offers something new, in the first track with any: the
  // quickest of the Coding track's, some code to read.
  const next = phone.locator(".continue");
  await expect(next).toContainText("Counting copies");
  await expect(next).toContainText("Coding · Something new · 0 of 90 minutes this week");
  await expect(phone.getByLabel("This week's practice")).toBeVisible();
  // It all fits across a phone's screen.
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
});

test("reviews cards a few at a time, saving each, and flags one that's wrong", async () => {
  await phone.locator(".track", { hasText: "Review" }).tap();
  await expect(phone).toHaveURL(/\/practice\/review$/);
  await expect(phone.locator(".learn-count")).toHaveText("1 of 3");

  await phone.getByRole("button", { name: "Show answer" }).tap();
  await expect(phone.getByRole("region", { name: "Answer" })).toBeVisible();
  await phone.getByRole("button", { name: "Good" }).tap();
  await expect(phone.locator(".learn-count")).toHaveText("2 of 3");
  // Saved as soon as it's marked, so the learner can stop at any moment.
  await expect.poll(() => scheduled()).toBe(1);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");

  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "This is wrong" }).tap();
  await phone.getByLabel("What's wrong? (optional)").fill("The example contradicts the answer");
  await phone.getByRole("button", { name: "Flag it" }).tap();

  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "Forgot" }).tap();
  await expect(phone.getByRole("heading", { name: "That's a step done" })).toBeVisible();
  await expect(phone.getByLabel(/mastered$/).first()).toBeVisible();

  await expect.poll(() => scheduled()).toBe(2);
  await expect
    .poll(async () => Object.values((await serverDeck()).flags).map((flag) => flag.note))
    .toEqual(["The example contradicts the answer"]);

  // The flagged card is left out, and the rest go on.
  await goHome();
  await expect(phone.locator(".track", { hasText: "Review" })).toContainText("7 new · 1 flagged");
});

test("checks mental maths as it's typed, right or wrong", async () => {
  await phone.locator(".track", { hasText: "Mental maths" }).tap();
  await expect(phone.locator(".learn-count")).toHaveText("1 of 3");
  // The track's icon is beside its name at the top, too.
  await expect(
    phone.getByRole("heading", { name: "Mental maths" }).locator('[data-icon="sigma"]'),
  ).toBeVisible();
  // Phones offer a keypad for numbers.
  await expect(phone.getByLabel("Your answer")).toHaveAttribute("inputmode", "decimal");

  await answer("lots");
  await expect(phone.getByText("Type a number, such as 42, 0.25, 1/4 or 25%.")).toBeVisible();
  const right = await answerShown();
  await answer("0");
  await expect(phone.locator(".learn-verdict")).toHaveText(`The answer is ${right}`);
  await phone.getByRole("button", { name: "Next" }).tap();

  await answer(await answerShown());
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await phone.getByRole("button", { name: "Next" }).tap();
  await phone.getByRole("button", { name: "I don't know" }).tap();
  await expect(phone.locator(".learn-verdict")).toContainText("The answer is");
  await phone.getByRole("button", { name: "Next" }).tap();
  await expect(
    phone.getByRole("heading", { name: "That's a step done: 1 of 3 right" }),
  ).toBeVisible();
  await expect.poll(() => scheduled("mental-maths")).toBe(3);
});

test("keeps a log of mistakes, whose kinds can be confirmed or changed", async () => {
  await goHome();
  await phone.getByRole("button", { name: /^Mistakes/ }).tap();
  await expect(phone).toHaveURL(/\/mistakes$/);
  // The card forgotten, and the two sums gone wrong.
  const rows = phone.getByRole("list", { name: "Mistakes" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  const unknown = rows.filter({ hasText: "Didn't know" });
  await expect(unknown).toContainText("Answer");
  await expect(unknown.getByLabel("Kind of mistake")).toHaveValue("concept-gap");
  await unknown.getByRole("button", { name: "Confirm" }).tap();
  await expect(unknown).toContainText("Confirmed");

  const wrong = rows.filter({ hasText: "Answered 0" });
  await wrong.getByLabel("Kind of mistake").selectOption("misread");
  await expect(wrong).toContainText("Suggested");
  await expect(phone.locator(".progress-counts")).toContainText("Concept gap");

  // Only one kind shown, when asked.
  await phone.getByLabel("Show").selectOption("misread");
  await expect(rows).toHaveCount(1);
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  const log = await (await phone.request.get("/api/mistakes")).json();
  const tags = (log as { mistakes: { confirmed: string | null }[] }).mistakes
    .map((m) => m.confirmed)
    .filter((tag) => tag !== null)
    .sort();
  expect(tags).toEqual(["concept-gap", "misread"]);
});

test("shows progress towards each of the pack's goals", async () => {
  await goHome();
  await phone.getByRole("button", { name: /^Goals/ }).tap();
  await expect(phone).toHaveURL(/\/goals$/);
  await expect(phone.locator(".home-link")).toHaveCount(3);
  await phone.getByRole("button", { name: /^Quick arithmetic/ }).tap();
  await expect(phone).toHaveURL(/\/goals\/quick-arithmetic$/);
  await expect(phone.getByRole("heading", { name: "Quick arithmetic" })).toBeVisible();
  await expect(phone.getByRole("region", { name: "Summary" })).toContainText(
    "Each skill to 80% mastered",
  );
  // The sums answered count towards multiplication's mastery, and the trend ends there.
  await expect(phone.getByLabel("Multiplication mastered")).toBeVisible();
  await expect(phone.getByRole("img", { name: /^Average mastery went from 0% to/ })).toBeVisible();
  await expect(phone.getByRole("heading", { name: "Weakest" })).toBeVisible();
  await expect(phone.getByRole("heading", { name: "Recent mistakes, by kind" })).toBeVisible();
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  await phone.getByRole("button", { name: "Every goal" }).tap();
  await expect(phone).toHaveURL(/\/goals$/);
});

test("has the grader check a flagged card, and unflags it", async () => {
  await goHome();
  await phone.getByRole("button", { name: /^Packs/ }).tap();
  await expect(phone).toHaveURL(/\/pack$/);
  const card = phone.getByRole("list", { name: "Flagged cards" }).getByRole("listitem");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("You said: The example contradicts the answer");
  await card.getByRole("button", { name: "Ask the grader" }).tap();
  const fix = card.getByRole("region", { name: "Proposed fix" });
  await expect(fix).toContainText("A corrected answer.");
  // The sample pack is built in, so its cards can't be changed; the fix can be turned down.
  await fix.getByRole("button", { name: "Approve fix" }).tap();
  await expect(phone.getByRole("alert")).toContainText("sample pack is built into Workshop");
  await fix.getByRole("button", { name: "Turn down" }).tap();
  await expect(fix).toHaveCount(0);
  await card.getByRole("button", { name: "Unflag" }).tap();
  await expect(phone.getByText("No cards are flagged.")).toBeVisible();
  await expect.poll(async () => Object.keys((await serverDeck()).flags)).toEqual([]);
  // Questions can only be added to a pack of one's own.
  await expect(phone.getByRole("region", { name: "Add a question" })).toContainText(
    "The sample pack is built in",
  );
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
});

test("offers long items only with a while, which turns itself off once the sitting's over", async () => {
  await goHome();
  const toggle = phone.getByRole("switch", { name: /I've got a while/ });
  await expect(toggle).not.toBeChecked();
  const next = phone.locator(".continue");
  await expect(next).not.toContainText("long");
  await toggle.tap();
  await expect(next).toContainText("Continue · long");
  // Long items take turns, and a timed round in the skill recent mistakes point to doesn't
  // outrank a new design session: with neither done yet, the design session goes first.
  await expect(next).toContainText("System design · Something new");
  await expect(next).not.toContainText("Timed rounds");
  // Still on after a reload, in the same sitting.
  await phone.reload();
  await expect(toggle).toBeChecked();
  await expect(next).toContainText("Continue · long");
  // Away for over half an hour, and the sitting's over.
  await phone.evaluate(() =>
    localStorage.setItem(
      "workshop:a-while",
      JSON.stringify({ lastActive: Date.now() - 31 * 60_000 }),
    ),
  );
  await phone.reload();
  await expect(toggle).not.toBeChecked();
  await expect(next).toBeVisible();
  await expect(next).not.toContainText("long");
});

test("works through a design session in stages, with the coach, stopping and carrying on", async () => {
  await phone.goto("/");
  await phone.getByRole("switch", { name: /I've got a while/ }).tap();
  const next = phone.locator(".continue");
  await phone.locator(".track", { hasText: "System design" }).tap();
  await phone.getByRole("button", { name: /key-value store/ }).tap();
  await expect(phone).toHaveURL(/\/design\/sample\/key-value-store$/);
  await phone.getByRole("button", { name: "Start the session" }).tap();

  const stage = phone.getByRole("region", { name: "Clarify the requirements" });
  await stage.getByLabel("Your notes").fill("Keep values by key, on many machines.");
  const coach = phone.getByRole("region", { name: "Coach" });
  await coach.getByRole("button", { name: "Ask the coach" }).tap();
  await expect(coach.locator(".design-turn.coach")).toHaveText(
    "At Clarify the requirements: what have you assumed here that might not hold?",
  );
  // The coach is answered aloud, and follows up.
  await holdToTalk(
    phone,
    coach.getByRole("button", { name: "Hold to dictate" }),
    "values are small",
    () => expect(coach.locator(".dictate-hearing")).toContainText("small"),
  );
  await expect(coach.getByLabel("Your answer to the coach")).toHaveValue("values are small");
  await coach.getByRole("button", { name: "Answer the coach" }).tap();
  await expect(coach.locator(".design-turn")).toHaveCount(3);
  await expect(coach.locator(".design-turn.learner")).toHaveText("values are small");

  await phone.getByRole("button", { name: "Next: estimate the scale" }).tap();
  await phone
    .getByRole("region", { name: "Estimate the scale" })
    .getByLabel("Your notes")
    .fill("A thousand writes a second, and ten thousand reads.");
  // Saved as it goes: a reload, or coming back later, carries on from here.
  await expect
    .poll(async () => {
      const response = await phone.request.get("/api/design/sample/key-value-store");
      const opened = (await response.json()) as {
        session: { stage: string; work: { scale?: { notes: string } } } | null;
      };
      return opened.session?.work.scale?.notes ?? "";
    })
    .toContain("ten thousand");
  await phone.reload();
  await expect(
    phone.getByRole("region", { name: "Estimate the scale" }).getByLabel("Your notes"),
  ).toHaveValue(/ten thousand reads/);
  await phone.getByRole("button", { name: "Stop here for now" }).tap();
  await expect(phone).toHaveURL(/\/design$/);
  await expect(phone.getByRole("button", { name: /key-value/ })).toContainText(
    "In progress, at scale",
  );
  await goHome();
  await expect(next).toContainText("Where you left off: estimate the scale");
  // Without a while, it's not offered, but it's still in the track, where it was left.
  await phone.getByRole("switch", { name: /I've got a while/ }).tap();
  await expect(next).not.toContainText("Where you left off: estimate the scale");
  const design = phone.locator(".track", { hasText: "System design" });
  await expect(design).toContainText("1 in progress");
  await design.tap();
  await phone.getByRole("button", { name: /key-value/ }).tap();
  await expect(phone.locator(".step.current")).toHaveText("Scale");
  // The stages already reached can be gone back to.
  await phone.locator(".step", { hasText: "Requirements" }).tap();
  await expect(
    phone.getByRole("region", { name: "Clarify the requirements" }).getByLabel("Your notes"),
  ).toHaveValue(/by key/);
  await phone.locator(".step", { hasText: "Scale" }).tap();

  await phone.getByRole("button", { name: "Next: outline the design" }).tap();
  const components = phone.getByRole("region", { name: "Components" });
  await components.getByRole("button", { name: "Add a component" }).tap();
  await components.getByLabel("Component 1", { exact: true }).fill("API");
  await components.getByLabel("What component 1 does").fill("Takes reads and writes");
  await components.getByLabel("What component 1 talks to").fill("Cache, Store");
  await components.getByRole("button", { name: "Add a component" }).tap();
  await components.getByLabel("Component 2", { exact: true }).fill("Cache");
  await components.getByRole("button", { name: "Add a component" }).tap();
  await components.getByLabel("Component 3", { exact: true }).fill("cache");
  await expect(phone.getByRole("alert")).toHaveText('Two components are called "cache".');
  await components.getByLabel("Component 3", { exact: true }).fill("Store");
  await expect(phone.getByRole("alert")).toHaveCount(0);
  await phone.getByRole("button", { name: "Next: deep-dive one component" }).tap();
  await phone.getByLabel("The component to go into").selectOption("Store");
  await phone
    .getByRole("region", { name: "Deep-dive one component" })
    .getByLabel("Your notes")
    .fill("Keys are spread by consistent hashing, with three copies of each.");
  await phone.getByRole("button", { name: "Next: trade-offs and failure modes" }).tap();
  await phone
    .getByRole("region", { name: "Trade-offs and failure modes" })
    .getByLabel("Your notes")
    .fill("If the cache fails, reads go to the store, which must take the load.");
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  await phone.getByRole("button", { name: "Finish and mark it" }).tap();
  const marked = phone.getByRole("region", { name: "Marked" });
  await expect(marked).toContainText("90%");
  await expect(marked).toContainText("Mistakes, kept in your log");
  await phone.getByRole("button", { name: "Done" }).tap();
  await expect(phone).toHaveURL(/\/design$/);
  await expect(phone.getByRole("button", { name: /key-value/ })).toContainText("last time 90%");
  // The whole session went to the grader, components and the coach's questions too.
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { item: string; detail: string }[];
  };
  const found = log.mistakes.find((m) => m.item === "sample/key-value-store");
  expect(found?.detail).toContain("- API: Takes reads and writes (talks to Cache, Store)");
  expect(found?.detail).toContain("Learner: values are small");
  expect(found?.detail).toContain("## Deep-dive one component: Store");
});

test("practises offline on a phone, keeping answers across a reload, and syncs them later", async () => {
  // The app is kept on the phone by its service worker, once that's in charge of the page.
  await phone.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await phone.reload();
  await expect
    .poll(() => phone.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await goHome();
  await expect(phone.locator(".track")).toHaveCount(7);

  await context.setOffline(true);
  // Opened afresh with no connection at all, the app still starts, from what the phone kept.
  await phone.goto("/practice/probability");
  await expect(phone.getByRole("heading", { name: "Probability" })).toBeVisible();
  await expect(phone.locator(".learn-sync")).toContainText("Offline");

  await answer(await answerShown());
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  await expect(phone.locator(".learn-sync")).toHaveText("Offline · 1 to sync");

  await phone.reload();
  await expect(phone.locator(".learn-sync")).toHaveText("Offline · 1 to sync");
  await answer("0");
  await expect(phone.locator(".learn-sync")).toHaveText("Offline · 2 to sync");
  expect(await scheduled("probability")).toBe(0);

  await context.setOffline(false);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved", { timeout: 15_000 });
  expect(await scheduled("probability")).toBe(2);
});

test("sends an answer again when the reply was lost, without counting it twice", async ({
  browser,
}) => {
  // Without the service worker, which would keep the page's requests from the test.
  const other = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LEARNING_PORT}`,
    serviceWorkers: "block",
  });
  const page = await other.newPage();
  // The page syncs as it opens; that sync must be done before the next one's reply is lost, or
  // it would be the one lost.
  const opened = page.waitForResponse((response) => response.url().includes("/api/learning/sync"));
  await page.goto(`/practice/probability?token=${token()}`);
  await opened;
  await expect(page.locator(".learn-sync")).toHaveText("Saved");
  // The server gets the first sync, but its reply never arrives, as on a dropping connection.
  const syncs: string[] = [];
  await page.route("**/api/learning/sync*", async (route) => {
    if (syncs.push(route.request().postData() ?? "") > 1) return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });
  await answer(await answerShown(page), page);
  await expect(page.locator(".learn-sync")).toContainText("Offline");
  // Tried again, it's taken once.
  await expect(page.locator(".learn-sync")).toHaveText("Saved", { timeout: 20_000 });
  expect(syncs.length).toBeGreaterThan(1);
  expect(syncs[1]).toBe(syncs[0]);
  await other.close();

  const deck = await serverDeck();
  const answered = Object.entries(deck.schedules).filter(([key]) =>
    deck.items.some((item) => item.key === key && item.kind === "probability"),
  );
  expect(answered).toHaveLength(3);
  expect(answered.every(([, schedule]) => schedule.reviews === 1)).toBe(true);
});

test("counts what was done towards the week, and offers more", async () => {
  await phone.goto("/");
  await expect(phone.locator(".week-label")).toContainText("minutes this week");
  // Every answer's in, so nothing's waiting on this phone.
  await expect(phone.locator(".home-pending")).toHaveCount(0);
  await expect(phone.locator(".track", { hasText: "Probability" })).toContainText("7 new");
});

test("marks a card answered in the learner's own words", async () => {
  await phone.goto("/practice/review");
  await phone.getByRole("button", { name: "Answer in my own words" }).tap();
  await phone.getByLabel("Your answer, in your own words").fill("Roughly the log of n");
  await phone.getByRole("button", { name: "Mark my answer" }).tap();
  await expect(phone.getByRole("region", { name: "Marked" })).toContainText("50%");
  await expect(phone.getByRole("region", { name: "Answer" })).toBeVisible();
  await phone.getByRole("button", { name: "Next" }).tap();
  await expect(phone.locator(".learn-count")).toHaveText("2 of 3");
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { source: string; detail: string }[];
  };
  expect(log.mistakes.some((m) => m.source === "grader" && m.detail.includes("Roughly"))).toBe(
    true,
  );
});

test("explains a card aloud, marked for what's right and how clearly it's put", async () => {
  await phone.goto("/practice/review");
  await phone.getByRole("button", { name: "Explain it aloud" }).tap();
  const explain = phone.getByRole("region", { name: "Explain it aloud" });
  await holdToTalk(
    phone,
    explain.getByRole("button", { name: "Hold to explain" }),
    "it sinks",
    () => expect(explain.locator(".dictate-hearing")).toContainText("sinks"),
  );
  await holdToTalk(
    phone,
    explain.getByRole("button", { name: "Hold to explain" }),
    "down one path",
    () => expect(explain.locator(".dictate-hearing")).toContainText("path"),
  );
  // Each hold adds to what was said.
  await expect(explain.getByLabel("What you said")).toHaveText("it sinks down one path");
  await explain.getByRole("button", { name: "Mark my explanation" }).tap();
  const marked = phone.getByRole("region", { name: "Marked" });
  await expect(marked).toContainText("50%");
  await expect(marked.getByRole("region", { name: "Clarity" })).toContainText(
    "How clearly you put it: 75%",
  );
  await expect(marked.getByRole("region", { name: "Clarity" }).locator("strong")).toHaveText(
    "before",
  );
  await expect(phone.getByRole("region", { name: "Answer" })).toBeVisible();
  await phone.getByRole("button", { name: "Next" }).tap();
  // It's an attempt, and its mistakes are in the log, as a written answer's are.
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { source: string; detail: string }[];
  };
  expect(
    log.mistakes.some((m) => m.source === "grader" && m.detail.includes("it sinks down one path")),
  ).toBe(true);
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
});

test("runs a timed round with the examiner, carrying on after a reload and a break, until time's up", async () => {
  await phone.goto("/");
  const toggle = phone.getByRole("switch", { name: /I've got a while/ });
  await expect(toggle).not.toBeChecked();
  // Rounds are long, so they're only offered with a while.
  const rounds = phone.locator(".track", { hasText: "Timed rounds" });
  await expect(phone.locator(".track")).toHaveCount(7);
  await expect(rounds).toHaveCount(0);
  await toggle.tap();
  await expect(rounds).toContainText("Against the clock, with the examiner");
  await rounds.tap();
  await expect(phone).toHaveURL(/\/rounds$/);
  await phone.getByRole("button", { name: /Two fair dice/ }).tap();
  await expect(phone).toHaveURL(/\/rounds\/sample\/two-dice-seven$/);
  // The problem isn't shown until the clock starts.
  await expect(phone.getByText("add up to 7")).toHaveCount(0);
  await phone.getByRole("radio", { name: /Probing/ }).check();
  await phone.getByRole("button", { name: "Start the clock" }).tap();

  const timer = phone.getByRole("timer", { name: "Time left" });
  await expect(timer).toHaveText(/^(10:00|9:5\d)$/);
  await expect(phone.getByText("Examiner: Probing")).toBeVisible();
  await expect(phone.getByText("What's the probability that they add up to 7?")).toBeVisible();
  await phone.getByLabel("Your working").fill("6 of the 36 pairs add up to 7");
  const examiner = phone.getByRole("region", { name: "Examiner" });
  await holdToTalk(
    phone,
    examiner.getByRole("button", { name: "Hold to dictate" }),
    "it's one in six",
    () => expect(examiner.locator(".dictate-hearing")).toContainText("six"),
  );
  await expect(examiner.getByLabel("Say to the examiner")).toHaveValue("it's one in six");
  await examiner.getByRole("button", { name: "Say it" }).tap();
  await expect(examiner.locator(".design-turn.coach")).toHaveText(
    `Probing: you said "it's one in six". What if there were three dice instead?`,
  );
  // The clock keeps in sight below everything, and it all fits across a phone.
  await examiner.getByRole("button", { name: "Say it" }).scrollIntoViewIfNeeded();
  await expect(timer).toBeInViewport();
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

  // The working's saved as it goes, with the clock: a reload carries on where it was.
  await expect.poll(() => serverWork("two-dice-seven")).toBe("6 of the 36 pairs add up to 7");
  await phone.reload();
  await expect(phone.getByLabel("Your working")).toHaveValue("6 of the 36 pairs add up to 7");
  await expect(examiner.locator(".design-turn")).toHaveCount(2);
  await expect(timer).toHaveText(/^9:\d\d$/);
  await expect(phone.getByText(/Welcome back/)).toHaveCount(0);

  // Paused, and back ten minutes later: the clock stopped while the app was closed.
  await phone.getByRole("button", { name: "Pause" }).tap();
  await expect(phone).toHaveURL(/\/rounds$/);
  await expect(phone.getByRole("region", { name: "Under way" })).toContainText(/left of 10/);
  const paused = changeRound("two-dice-seven", (round) => {
    round.seen_at -= 10 * 60_000;
  });
  await phone
    .getByRole("button", { name: /Two fair dice/ })
    .first()
    .tap();
  await expect(phone.getByText(/Welcome back. The clock stopped/)).toBeVisible();
  const left = 600 - Math.floor(paused.used_ms / 1000);
  const [minutes, seconds] = ((await timer.innerText()).match(/^(\d+):(\d\d)$/) ?? [])
    .slice(1)
    .map(Number);
  // No more than the short gap the server allows went by, not the ten minutes.
  expect(left - ((minutes ?? 0) * 60 + (seconds ?? 0))).toBeLessThanOrEqual(25);
  await examiner.getByLabel("Say to the examiner").fill("I'm back");
  await examiner.getByRole("button", { name: "Say it" }).tap();
  await expect(examiner.locator(".design-turn.coach").last()).toHaveText(
    `Probing: welcome back. You said "I'm back"; carry on from there.`,
  );
  await expect(phone.getByText(/Welcome back. The clock stopped/)).toHaveCount(0);

  // Nearly out of time: when it runs out, the round ends and goes to the grader.
  await phone.getByLabel("Your working").fill("6 of 36 pairs, so 1/6. Three dice: 27/216.");
  // Paused straight after typing, the working goes to the server as the round closes.
  await phone.getByRole("button", { name: "Pause" }).tap();
  await expect
    .poll(() => serverWork("two-dice-seven"))
    .toBe("6 of 36 pairs, so 1/6. Three dice: 27/216.");
  changeRound("two-dice-seven", (round) => {
    round.used_ms = round.minutes * 60_000 - 3_000;
  });
  await phone
    .getByRole("button", { name: /Two fair dice/ })
    .first()
    .tap();
  await expect(timer).toHaveText(/^0:0[0-3]$/);
  await expect(phone.getByText("Time's up.")).toBeVisible();
  const marked = phone.getByRole("region", { name: "Marked" });
  await expect(marked).toContainText("50%");
  await expect(marked).toContainText("Mistakes, kept in your log");
  // The working typed before it paused went to the grader, with what was said.
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { item: string; detail: string }[];
  };
  const found = log.mistakes.find(
    (m) => m.item === "sample/two-dice-seven" && m.detail.includes("Examiner:"),
  );
  expect(found?.detail).toContain("Three dice: 27/216.");
  expect(found?.detail).toContain("Learner: it's one in six");
  await phone.getByRole("button", { name: "Done" }).tap();
  await expect(phone).toHaveURL(/\/rounds$/);
  await expect(phone.getByRole("region", { name: "Under way" })).toHaveCount(0);
});

test("ends a round left for over half an hour, marked but not counted as an attempt", async () => {
  await phone.goto("/rounds/sample/islands");
  // The first style is chosen unless another is.
  await expect(phone.getByRole("radio", { name: /Steady/ })).toBeChecked();
  await phone.getByRole("button", { name: "Start the clock" }).tap();
  await expect(phone.getByText("Examiner: Steady")).toBeVisible();
  await expect(phone.locator(".round-example")).not.toHaveCount(0);
  await phone.getByLabel("Your working").fill("Flood fill from each unvisited land square");
  await phone.getByRole("button", { name: "Pause" }).tap();
  await expect.poll(() => serverWork("islands")).toContain("Flood fill");
  changeRound("islands", (round) => {
    round.seen_at -= 31 * 60_000;
  });
  await goHome();
  const next = phone.locator(".continue");
  await expect(next).toContainText("Ended while you were away, to be marked");
  await next.tap();
  await expect(phone.getByText(/ended while you were away/)).toBeVisible();
  await expect(phone.getByRole("region", { name: "Marked" })).toContainText("50%");
  const deck = await serverDeck();
  expect(deck.schedules["sample/islands"]).toBeUndefined();
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { item: string; detail: string }[];
  };
  expect(log.mistakes.find((m) => m.item === "sample/islands")?.detail).toContain("Flood fill");
  await phone.getByRole("button", { name: "Done" }).tap();
  await goHome();
  await phone.getByRole("switch", { name: /I've got a while/ }).tap();
  await expect(phone.locator(".track", { hasText: "Timed rounds" })).toHaveCount(0);
  // What the grader found is in the log with everything else.
  await phone.getByRole("button", { name: /^Mistakes/ }).tap();
  await expect(
    phone
      .getByRole("list", { name: "Mistakes" })
      .getByRole("listitem")
      .filter({ hasText: "Flood fill" }),
  ).toHaveCount(1);
});

test("marks an estimate right within its bounds, saying how close it must be", async () => {
  await phone.goto("/");
  await phone.locator(".track", { hasText: "Estimation" }).tap();
  await expect(phone.getByRole("heading", { name: "Estimation" })).toBeVisible();
  // An answer just inside the bounds is close enough, and one ten times off isn't.
  for (const [scale, verdict] of [
    ["inside", "Close enough"],
    ["far", "Not close enough"],
  ] as const) {
    const shown = (await phone.locator(".learn-prompt").innerText()).trim();
    const deck = await serverDeck();
    const item = deck.items.find((i) => i.instances?.some((x) => x.prompt === shown));
    const exact = item?.instances?.find((x) => x.prompt === shown)?.answer;
    const tolerance = item?.tolerance;
    if (exact === undefined || tolerance === undefined) throw new Error(`no estimate ${shown}`);
    const bound = tolerance.factor
      ? `within a factor of ${tolerance.factor}`
      : `within ${tolerance.relative * 100}%`;
    await expect(phone.locator(".learn-estimate")).toHaveText(`An estimate: ${bound} counts.`);
    const inside = tolerance.factor
      ? exact * tolerance.factor * 0.9
      : exact * (1 + tolerance.relative * 0.8);
    await answer(String(scale === "inside" ? inside : exact * 10));
    await expect(phone.locator(".learn-verdict")).toContainText(`${verdict}: it's `);
    await phone.getByRole("button", { name: "Next" }).tap();
  }
});
