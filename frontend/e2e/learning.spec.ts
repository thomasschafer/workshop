import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BrowserContext,
  devices,
  expect,
  type Page,
  type Request,
  test,
} from "@playwright/test";
import { LEARNING_HOME, LEARNING_PORT } from "./fixture";
import { setOffline } from "./offline";
import { holdToTalk, installSimulatedSpeech } from "./speech";

// The tests share one phone and run in order, like one learner using the app, from a server
// that starts with nothing done and the sample pack.
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let phone: Page;
/** The probability question retired offline, to bring back later. */
let retiredProbability: { key: string; label: string } | null = null;

const token = () => readFileSync(join(LEARNING_HOME, "config", "token"), "utf8").trim();

interface Deck {
  items: {
    key: string;
    kind: string;
    label: string;
    prompt: string;
    answer?: number;
    instances?: { prompt: string; answer: number }[];
    tolerance?: { absolute: number; relative: number; factor?: number };
  }[];
  schedules: Record<string, { reviews: number; stability: number }>;
  flags: Record<string, { note: string | null }>;
  retirements: Record<string, { state: string; at: number }>;
}

/** The deck as the server has it now, which is what it's learnt from the attempts it's been sent. */
async function serverDeck(): Promise<Deck> {
  const response = await phone.request.get("/api/learning/deck");
  expect(response.ok()).toBe(true);
  return (await response.json()) as Deck;
}

/** The question showing, from the deck the phone keeps: its item, and its answer. */
async function shown(on: Page = phone): Promise<{ key: string; label: string; answer: string }> {
  const prompt = (await on.locator(".learn-prompt").innerText()).trim();
  return on.evaluate((prompt) => {
    const saved = JSON.parse(localStorage.getItem("workshop:learning") ?? "null") as {
      deck: Deck;
    };
    for (const item of saved.deck.items) {
      const found = { key: item.key, label: item.label };
      if (
        item.kind === "probability" &&
        item.prompt.replace(/\s+/g, " ") === prompt.replace(/\s+/g, " ")
      ) {
        return { ...found, answer: String(item.answer) };
      }
      const instance = item.instances?.find((i) => i.prompt === prompt);
      if (instance) return { ...found, answer: String(instance.answer) };
    }
    throw new Error(`no item in the deck asks ${JSON.stringify(prompt)}`);
  }, prompt);
}

/** The answer to the question showing, from the deck the phone keeps. */
async function answerShown(on: Page = phone): Promise<string> {
  return (await shown(on)).answer;
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
  await expect(phone.locator(".track", { hasText: "Review" })).toContainText("1 lesson · 9 new");
  // Nothing's due yet, so Continue offers something new, in the first track with any: the
  // quickest of the Coding track's, some code to read.
  const next = phone.locator(".continue");
  await expect(next).toContainText("Adding to a global");
  await expect(next).toContainText("Coding · Something new");
  await expect(next).not.toContainText("this week");
  await expect(phone.getByLabel("This week's practice")).toBeVisible();
  // It all fits across a phone's screen.
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
});

test("reviews cards continuously across steps, saving each, and flags one that's wrong", async () => {
  await phone.locator(".track", { hasText: "Review" }).tap();
  await expect(phone).toHaveURL(/\/practice\/review$/);
  await expect(phone.locator(".learn-count")).toHaveText(/^\d+ of \d+ minutes this week$/);
  // The track's lesson is offered before new cards; "Not now" skips it for today and carries on.
  await expect(phone.locator(".lesson-flow-card")).toContainText("How a binary heap works");
  await phone.getByRole("button", { name: "Not now" }).tap();
  const firstPrompt = await phone.locator(".learn-prompt").textContent();

  await phone.getByRole("button", { name: "Show answer" }).tap();
  await expect(phone.getByRole("region", { name: "Answer" })).toBeVisible();
  await phone.getByRole("button", { name: "Good" }).tap();
  await expect(phone.locator(".learn-count")).toHaveText(/^1 done · \d+ of \d+ minutes this week$/);
  // Saved as soon as it's marked, so the learner can stop at any moment.
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  expect(await scheduled()).toBe(1);

  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "This is wrong" }).tap();
  await phone.getByLabel("What's wrong? (optional)").fill("The example contradicts the answer");
  await phone.getByRole("button", { name: "Flag it" }).tap();
  await expect(phone.locator(".learn-count")).toHaveText(/^2 done · \d+ of \d+ minutes this week$/);
  const thirdPrompt = await phone.locator(".learn-prompt").textContent();

  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "Forgot" }).tap();
  // The first step's three cards are done; the next step's cards follow straight on without a
  // screen in between.
  await expect(phone.locator(".learn-count")).toHaveText(/^3 done · \d+ of \d+ minutes this week$/);
  await expect(phone.getByRole("region", { name: "Done" })).toHaveCount(0);
  const fourthPrompt = await phone.locator(".learn-prompt").textContent();
  expect(fourthPrompt).not.toBe(firstPrompt);
  expect(fourthPrompt).not.toBe(thirdPrompt);
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  expect(await scheduled()).toBe(2);
  expect(Object.values((await serverDeck()).flags).map((flag) => flag.note)).toEqual([
    "The example contradicts the answer",
  ]);

  // The flagged card is left out, and the rest go on.
  await goHome();
  await expect(phone.locator(".track", { hasText: "Review" })).toContainText("6 new · 1 flagged");
});

test("checks mental maths as it's typed, right or wrong", async () => {
  await phone.locator(".track", { hasText: "Mental maths" }).tap();
  await expect(phone.locator(".learn-count")).toHaveText(/^\d+ of \d+ minutes this week$/);
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
  // Made afresh each time, a sum is never the same question again, so isn't offered retiring.
  await expect(phone.getByRole("button", { name: /Too easy/ })).toHaveCount(0);
  await phone.getByRole("button", { name: "Next" }).tap();
  await phone.getByRole("button", { name: "I don't know" }).tap();
  await expect(phone.locator(".learn-verdict")).toContainText("The answer is");
  await phone.getByRole("button", { name: "Next" }).tap();
  // Three sums fill the first step, and the next sum follows straight away.
  await expect(phone.locator(".learn-count")).toHaveText(/^3 done · \d+ of \d+ minutes this week$/);
  await expect(phone.getByRole("region", { name: "Done" })).toHaveCount(0);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  expect(await scheduled("mental-maths")).toBe(3);
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
  // Shown once the server has it.
  await expect(phone.getByText("No cards are flagged.")).toBeVisible();
  expect(Object.keys((await serverDeck()).flags)).toEqual([]);
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

test("works through a design session in stages, asking the coach and answering it, stopping and carrying on", async () => {
  await phone.goto("/");
  await phone.getByRole("switch", { name: /I've got a while/ }).tap();
  const next = phone.locator(".continue");
  await phone.locator(".track", { hasText: "System design" }).tap();
  await phone.getByRole("button", { name: /key-value store/ }).tap();
  await expect(phone).toHaveURL(/\/design\/sample\/key-value-store$/);
  await phone.getByRole("button", { name: "Start the session" }).tap();

  const stage = phone.getByRole("region", { name: "Clarify the requirements" });
  await stage.getByLabel("Your notes").fill("Keep values by key, on many machines.");
  // Finding out the requirements, the learner asks, and the coach answers from the brief.
  const coach = phone.getByRole("region", { name: "Coach" });
  const ask = coach.getByRole("button", { name: "Ask the coach" });
  await expect(ask).toBeDisabled();
  await coach.getByLabel("Your question").fill("How big are the values?");
  await ask.tap();
  await expect(coach.locator(".design-turn.learner")).toHaveText("How big are the values?");
  await expect(coach.locator(".design-turn.coach")).toHaveText(
    "Data: keys up to 256 bytes, values usually about 1 KB and at most 1 MB. 10 TB in all today, growing by half each year.",
  );
  await expect(coach.getByLabel("Your question")).toHaveValue("");
  // A question can be asked aloud too.
  await holdToTalk(
    phone,
    coach.getByRole("button", { name: "Hold to dictate" }),
    "what latency do reads need",
    () => expect(coach.locator(".dictate-hearing")).toContainText("need"),
  );
  await expect(coach.getByLabel("Your question")).toHaveValue("what latency do reads need");
  await ask.tap();
  await expect(coach.locator(".design-turn")).toHaveCount(4);
  await expect(coach.locator(".design-turn.coach").last()).toHaveText(
    "Latency: reads and writes under 10 ms at the 99th percentile, within a data centre.",
  );
  // The brief stays hidden, beyond what's been asked: neither the page nor what the app is sent
  // has the rest of it.
  const unasked = "acknowledged";
  await expect(phone.getByText(unasked)).toHaveCount(0);
  const sent = await (await phone.request.get("/api/design/sample/key-value-store")).text();
  expect(sent).toContain("10 ms at the 99th percentile");
  expect(sent).not.toContain(unasked);

  // The coach gives the numbers asked for, and leaves the estimating to the learner.
  await phone.getByRole("button", { name: "Next: estimate the scale" }).tap();
  await coach.getByLabel("Your question").fill("How many reads a second at peak?");
  await ask.tap();
  await expect(coach.locator(".design-turn.coach")).toContainText("200,000 reads");
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

  // From here, each save takes a while to reach the server, as on a poor connection, so the
  // stages are moved through, and the session finished, with saves still on their way.
  const saves = "**/api/design/*/*/session";
  await phone.route(saves, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fallback();
  });
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
  // Later on, the coach asks, and the learner answers.
  const tradeOffs = phone.getByRole("region", { name: "Coach" });
  await tradeOffs.getByRole("button", { name: "Ask the coach" }).tap();
  await expect(tradeOffs.locator(".design-turn.coach")).toHaveText(
    "At Trade-offs and failure modes: what have you assumed here that might not hold?",
  );
  await tradeOffs.getByLabel("Your answer to the coach").fill("that a copy is always up");
  await tradeOffs.getByRole("button", { name: "Answer the coach" }).tap();
  await expect(tradeOffs.locator(".design-turn")).toHaveCount(3);
  await expect(phone.getByText(unasked)).toHaveCount(0);
  await phone.getByRole("button", { name: "Finish and mark it" }).tap();
  const marked = phone.getByRole("region", { name: "Marked" });
  await expect(marked).toContainText("90%");
  await expect(marked).toContainText("Mistakes, kept in your log");
  // What was asked is marked too: the requirements never found out are noted, and kept in the
  // log as missed.
  const missed = marked.getByRole("region", { name: "Missed, kept in your log" });
  await expect(missed).toContainText("Durability");
  await expect(marked.getByRole("region", { name: "Found out" })).toContainText("Latency");
  // Once it's marked, the brief is shown.
  await expect(phone.getByRole("region", { name: "The brief" })).toContainText(unasked);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  await phone.unroute(saves);
  await phone.getByRole("button", { name: "Done" }).tap();
  await expect(phone).toHaveURL(/\/design$/);
  await expect(phone.getByRole("button", { name: /key-value/ })).toContainText("last time 90%");
  // The whole session went to the grader, components and the coach's questions too.
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { item: string; detail: string }[];
  };
  const mine = log.mistakes.filter((m) => m.item === "sample/key-value-store");
  const found = mine.find((m) => m.detail.startsWith("Nothing on the unusual cases"));
  expect(found?.detail).toContain("- API: Takes reads and writes (talks to Cache, Store)");
  expect(found?.detail).toContain("Learner: what latency do reads need");
  expect(found?.detail).toContain("Learner: that a copy is always up");
  expect(found?.detail).toContain("## Deep-dive one component: Store");
  expect(mine.map((m) => m.detail)).toContain("Didn't find out: Durability");
});

/** Waits until the app's kept on the phone by its service worker, which is in charge of the page. */
async function keptOnThePhone(): Promise<void> {
  await phone.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (await phone.evaluate(() => navigator.serviceWorker.controller !== null)) return;
  await phone.reload();
  await expect
    .poll(() => phone.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

test("practises offline on a phone, keeping answers across a reload, and syncs them later", async () => {
  await keptOnThePhone();
  await goHome();
  await expect(phone.locator(".track")).toHaveCount(7);

  await setOffline(context, true);
  // Opened afresh with no connection at all, the app still starts, from what the phone kept.
  await phone.goto("/practice/probability");
  await expect(phone.getByRole("heading", { name: "Probability" })).toBeVisible();
  await expect(phone.locator(".learn-sync")).toContainText("Offline");
  // Answers can be fractions or percentages, which a phone's number pad can't type.
  await expect(phone.getByLabel("Your answer")).toHaveAttribute("inputmode", "text");

  const question = await shown();
  await answer(question.answer);
  await expect(phone.locator(".learn-verdict")).toHaveText("Right");
  // Answered right, it waits to hear whether it was too easy, and retiring works offline too.
  await expect(phone.getByRole("button", { name: "Got it" })).toBeFocused();
  await expect(phone.locator(".learn-sync")).toHaveText("Offline");
  await phone.getByRole("button", { name: "Too easy: retire it" }).tap();
  // The retirement goes with the attempt that made it, and practice flows straight to the next
  // question offline.
  await expect(phone.locator(".learn-sync")).toHaveText("Offline · 1 to sync");
  await expect(phone.locator(".learn-count")).toHaveText(/^1 done · \d+ of \d+ minutes this week$/);
  expect((await shown()).key).not.toBe(question.key);

  await phone.reload();
  await expect(phone.locator(".learn-sync")).toHaveText("Offline · 1 to sync");
  await expect(phone.locator(".learn-count")).toHaveText(/^\d+ of \d+ minutes this week$/);
  // It's never offered again, even offline.
  const second = await shown();
  expect(second.key).not.toBe(question.key);
  await answer("0");
  await expect(phone.locator(".learn-sync")).toHaveText("Offline · 2 to sync");
  // A wrong answer offers nothing but going on.
  await expect(phone.getByRole("button", { name: "Got it" })).toHaveCount(0);
  await phone.getByRole("button", { name: "Next" }).tap();
  await expect(phone.locator(".learn-count")).toHaveText(/^1 done · \d+ of \d+ minutes this week$/);
  expect((await shown()).key).not.toBe(second.key);
  expect(await scheduled("probability")).toBe(0);

  await setOffline(context, false);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  expect(await scheduled("probability")).toBe(2);
  expect((await serverDeck()).retirements[question.key]?.state).toBe("retired");
  retiredProbability = question;
});

test("offers to reload once a new release takes over, and reloads by itself at home on coming back", async () => {
  await keptOnThePhone();
  await phone.goto("/");
  await expect(phone.locator(".track").first()).toBeVisible();
  const card = phone.getByRole("status").filter({ hasText: "Workshop has been updated" });
  await expect(card).toHaveCount(0);
  // A new release's service worker takes over the page, as it does once installed.
  const takeOver = () =>
    phone.evaluate(() => {
      Object.assign(window, { sameLoad: true });
      navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
    });
  // Asked mid-reload, the page can't answer yet, so it's as if it hadn't reloaded.
  const sameLoad = () => phone.evaluate(() => "sameLoad" in window).catch(() => true);

  await takeOver();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Reload later" }).tap();
  await expect(card).toHaveCount(0);
  await takeOver();
  await expect(card).toHaveCount(0);

  // Going away for a while and coming back reloads the home screen, which has nothing to lose.
  await phone.evaluate(() => {
    let state: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", { get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
    const now = Date.now.bind(Date);
    Date.now = () => now() + 60_000;
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(sameLoad).toBe(false);
  await expect(phone.locator(".track").first()).toBeVisible();

  // Tapping Reload reloads at once, wherever it is.
  await takeOver();
  await card.getByRole("button", { name: "Reload", exact: true }).tap();
  await expect.poll(sameLoad).toBe(false);
  await expect(card).toHaveCount(0);
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
  // Any other request that's answered meanwhile, such as for the track's problems as the step
  // ends, says the server can be reached, and the answer's sent again at once. "Offline" may then
  // be shown for only a moment, so everything the sync chip says is kept, so as not to miss it.
  await page.evaluate(() => {
    const said: string[] = [];
    Object.assign(window, { syncSaid: said });
    new MutationObserver(() => {
      const text = document.querySelector(".learn-sync")?.textContent;
      if (text && text !== said.at(-1)) said.push(text);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await answer(await answerShown(page), page);
  await page.getByRole("button", { name: "Got it" }).tap();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { syncSaid: string[] }).syncSaid))
    .toContainEqual(expect.stringContaining("Offline"));
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

test("sends a question answered right further off with Got it, finishes the track, and brings a retired one back", async () => {
  if (!retiredProbability) throw new Error("the offline test retires a question first");
  const back = retiredProbability;
  await phone.goto("/practice/probability");
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  const question = await shown();
  await answer(question.answer);
  // Got it is focused, so Enter is enough, and practice flows straight to the next question
  // without a screen between steps.
  await expect(phone.getByRole("button", { name: "Got it" })).toBeFocused();
  await phone.keyboard.press("Enter");
  await expect(phone.locator(".learn-count")).toHaveText(/^1 done · \d+ of \d+ minutes this week$/);
  await expect(phone.getByRole("region", { name: "Done" })).toHaveCount(0);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  // Rated easy, it's further off than a card answered Good for the first time.
  const deck = await serverDeck();
  expect(deck.retirements[question.key]).toBeUndefined();
  const cards = Object.entries(deck.schedules).filter(([key]) =>
    deck.items.some((item) => item.key === key && item.kind === "card"),
  );
  const good = Math.max(...cards.map(([, schedule]) => schedule.stability));
  expect(deck.schedules[question.key]?.stability).toBeGreaterThan(good * 2);

  // Work through the remaining six questions in the track, each its own step, without seeing
  // the Done screen until nothing is left.
  const seen = new Set<string>([question.key]);
  for (let i = 1; i < 7; i++) {
    const current = await shown();
    expect(seen.has(current.key)).toBe(false);
    seen.add(current.key);
    if (i < 3) {
      await answer(current.answer);
      await phone.getByRole("button", { name: "Got it" }).tap();
    } else {
      await answer("0");
      await phone.getByRole("button", { name: "Next" }).tap();
    }
    if (i < 6) {
      await expect(phone.locator(".learn-count")).toHaveText(
        new RegExp(`^${i + 1} done · \\d+ of \\d+ minutes this week$`),
      );
      await expect(phone.getByRole("region", { name: "Done" })).toHaveCount(0);
    }
  }

  // Once nothing is left in the track for now, the Done screen appears without skill meters
  // or an "Another step" button.
  await expect(
    phone.getByRole("heading", { name: "That's everything for now: 3 of 7 right" }),
  ).toBeVisible();
  await expect(phone.getByRole("button", { name: "Another step" })).toHaveCount(0);
  await expect(phone.getByLabel(/mastered$/)).toHaveCount(0);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");

  // The one retired offline is listed here, to bring back; due straight away, it opens at once.
  const retired = phone.getByRole("region", { name: "Retired" });
  await expect(retired).toContainText(back.label);
  await retired.getByRole("button", { name: "Bring back" }).tap();
  await expect(retired).toHaveCount(0);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  expect((await serverDeck()).retirements[back.key]?.state).toBe("brought_back");
  expect((await shown()).key).toBe(back.key);
  await answer("0");
  await phone.getByRole("button", { name: "Next" }).tap();
  await expect(
    phone.getByRole("heading", { name: "That's everything for now: 3 of 8 right" }),
  ).toBeVisible();
  // Opening the track again with nothing left says so.
  await phone.reload();
  await expect(phone.getByRole("heading", { name: "Nothing to do here for now" })).toBeVisible();
  // It all fits across a phone's screen.
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
});

test("marks a card answered in the learner's own words", async () => {
  await phone.goto("/practice/review");
  await phone.getByRole("button", { name: "Answer in my own words" }).tap();
  await phone.getByLabel("Your answer, in your own words").fill("Roughly the log of n");
  await phone.getByRole("button", { name: "Mark my answer" }).tap();
  await expect(phone.getByRole("region", { name: "Marked" })).toContainText("50%");
  await expect(phone.getByRole("region", { name: "Answer" })).toBeVisible();
  await phone.getByRole("button", { name: "Next" }).tap();
  await expect(phone.locator(".learn-count")).toHaveText(/^1 done · \d+ of \d+ minutes this week$/);
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { source: string; detail: string }[];
  };
  expect(log.mistakes.some((m) => m.source === "grader" && m.detail.includes("Roughly"))).toBe(
    true,
  );
});

test("explains a card aloud, marked for what's right and how clearly it's put", async () => {
  await keptOnThePhone();
  await phone.goto("/practice/review");
  await phone.getByRole("button", { name: "Explain it aloud" }).tap();
  const prompt = await phone.locator(".learn-prompt").innerText();
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
  // The connection goes before the deck on the phone catches up with the attempt, but it isn't
  // offered again, even after a reload.
  await setOffline(context, true);
  await phone.getByRole("button", { name: "Next" }).tap();
  await phone.reload();
  await expect(phone.locator(".learn-count")).toHaveText(/^\d+ of \d+ minutes this week$/);
  expect(await phone.locator(".learn-prompt").innerText()).not.toBe(prompt);
  await setOffline(context, false);
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

/** The card showing, by its key, from the deck the phone keeps. */
async function cardShown(on: Page = phone): Promise<string> {
  const prompt = (await on.locator(".learn-prompt").innerText()).replace(/\s+/g, " ").trim();
  return on.evaluate((prompt) => {
    const saved = JSON.parse(localStorage.getItem("workshop:learning") ?? "null") as {
      deck: Deck;
    };
    const card = saved.deck.items.find(
      (item) =>
        item.kind === "card" &&
        prompt.startsWith((item.prompt.split("\n\n")[0] ?? "").replace(/\s+/g, " ").trim()),
    );
    if (!card) throw new Error(`no card in the deck asks ${JSON.stringify(prompt)}`);
    return card.key;
  }, prompt);
}

/** The cards the phone's deck says are being followed up. */
async function followedUp(): Promise<string[]> {
  return phone.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("workshop:learning") ?? "null") as {
      deck: { follow_ups?: string[] };
    };
    return saved.deck.follow_ups ?? [];
  });
}

test("goes deeper on a card with the tutor's questions, carrying on after a reload, then marks it all", async () => {
  await phone.goto("/practice/review");
  const key = await cardShown();
  await phone.getByRole("button", { name: "Answer in my own words" }).tap();
  await phone.getByLabel("Your answer, in your own words").fill("It goes down one path");
  await phone.getByRole("button", { name: "Go deeper" }).tap();
  const deeper = phone.getByRole("region", { name: "Follow-up questions" });
  await expect(deeper.getByRole("heading")).toHaveText("Follow-up question 1 of 2");
  await expect(deeper.locator(".design-turn.coach")).toHaveText(
    'Question 1 of 2: why is it that "It goes down one path"?',
  );
  // The answer isn't shown while the tutor's asking about it.
  await expect(phone.getByRole("region", { name: "Answer" })).toHaveCount(0);

  // A reply part-written is kept on the phone, and the card comes first again after a reload.
  await deeper.getByLabel("Your answer").fill("because each level halves");
  await expect.poll(followedUp).toEqual([key]);
  await phone.reload();
  expect(await cardShown()).toBe(key);
  await expect(deeper.getByLabel("Your answer")).toHaveValue("because each level halves");
  await deeper.getByRole("button", { name: "Answer", exact: true }).tap();
  await expect(deeper.getByRole("heading")).toHaveText("Follow-up question 2 of 2");
  await expect(deeper.locator(".design-turn.coach").last()).toContainText(
    "because each level halves",
  );

  // The next is explained aloud, which is marked for clarity too.
  await deeper.getByRole("button", { name: "Say it aloud" }).tap();
  await holdToTalk(
    phone,
    deeper.getByRole("button", { name: "Hold to explain" }),
    "the root is the smallest",
    () => expect(deeper.locator(".dictate-hearing")).toContainText("smallest"),
  );
  await expect(deeper.getByLabel("What you said")).toHaveText("the root is the smallest");
  await deeper.getByRole("button", { name: "Answer", exact: true }).tap();
  await expect(deeper).toContainText("That's all its questions.");
  await expect(deeper.locator(".follow-ups-aloud")).toHaveCount(1);
  await deeper.getByRole("button", { name: "Mark my answers" }).tap();

  const marked = phone.getByRole("region", { name: "Marked" });
  await expect(marked).toContainText("60%");
  await expect(marked.getByRole("region", { name: "Clarity" })).toContainText(
    "How clearly you put it: 70%",
  );
  await expect(marked).toContainText("Shallow: the root is the smallest");
  await expect(phone.getByRole("region", { name: "Answer" })).toBeVisible();
  await phone.getByText("What you said").tap();
  await expect(phone.locator(".follow-ups-done .design-turn")).toHaveCount(5);
  const width = phone.viewportSize()?.width ?? 0;
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  await phone.getByRole("button", { name: "Next" }).tap();

  // It's the card's attempt, with what was shallow in the mistake log, and the questions are over.
  const deck = (await serverDeck()) as Deck & { follow_ups: string[] };
  expect(deck.schedules[key]?.reviews).toBe(1);
  expect(deck.follow_ups).toEqual([]);
  const log = (await (await phone.request.get("/api/mistakes")).json()) as {
    mistakes: { item: string; source: string; detail: string; suggested: string | null }[];
  };
  const shallow = log.mistakes.find((m) => m.detail === "Shallow: the root is the smallest");
  expect(shallow).toMatchObject({ item: key, source: "grader", suggested: "concept-gap" });
});

/** Whether everything fits across the phone's screen, or a narrower one's. */
async function fitsAcross(width?: number): Promise<void> {
  const size = phone.viewportSize();
  if (!size) throw new Error("the phone has no viewport");
  if (width !== undefined) await phone.setViewportSize({ width, height: size.height });
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width ?? size.width,
  );
  if (width !== undefined) await phone.setViewportSize(size);
}

/** Starts follow-up questions on a card as another device would, by its key. */
async function startElsewhere(key: string, text: string): Promise<void> {
  const response = await phone.request.post(`/api/cards/${key}/follow-ups/start`, {
    data: { id: crypto.randomUUID(), text },
  });
  expect(response.ok()).toBe(true);
}

/** The follow-up questions under way on a card, as the server has them. */
async function serverFollowUps(key: string): Promise<{
  questions: { text: string; reply: { text: string } | null }[];
} | null> {
  const response = await phone.request.get(`/api/cards/${key}/follow-ups`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { exchange: never }).exchange;
}

test("keeps an answer when the tutor can't be reached, asks again, and sends a reply before marking it now", async () => {
  await phone.goto("/practice/review");
  const key = await cardShown();
  await phone.getByRole("button", { name: "Explain it aloud" }).tap();
  const explain = phone.getByRole("region", { name: "Explain it aloud" });
  await holdToTalk(
    phone,
    explain.getByRole("button", { name: "Hold to explain" }),
    "the tutor is away",
    () => expect(explain.locator(".dictate-hearing")).toContainText("away"),
  );
  // Going deeper sits beside marking it, and still fits on a narrow phone.
  await expect(explain.getByRole("button", { name: "Go deeper" })).toBeVisible();
  await fitsAcross(360);
  await explain.getByRole("button", { name: "Go deeper" }).tap();
  const deeper = phone.getByRole("region", { name: "Follow-up questions" });
  await expect(deeper.getByRole("alert")).toContainText("can't be reached");
  // What was said is kept, explained aloud.
  await expect(deeper.locator(".design-turn.learner")).toHaveText("the tutor is away (aloud)");
  // Asked again, once it can be reached, it carries on.
  await deeper.getByRole("button", { name: "Ask the tutor" }).tap();
  await expect(deeper.locator(".design-turn.coach")).toHaveText(
    'Question 1 of 2: why is it that "the tutor is away"?',
  );
  await expect(deeper.getByRole("alert")).toHaveCount(0);
  await fitsAcross(360);
  // A reply written but not sent is sent before it's marked, rather than lost.
  await deeper.getByRole("button", { name: "Type it" }).tap();
  await deeper.getByLabel("Your answer").fill("no idea really");
  await deeper.getByRole("button", { name: "Send it and mark it now" }).tap();
  await expect(phone.getByRole("region", { name: "Marked" })).toContainText(
    "Shallow: no idea really",
  );
  // What was said, shown with the marks, has the reply sent as it was marked.
  await phone.getByText("What you said").tap();
  await expect(phone.locator(".follow-ups-done .design-turn").last()).toHaveText("no idea really");
  await expect.poll(followedUp).toEqual([]);
  expect(await serverFollowUps(key)).toBeNull();
  expect((await serverDeck()).schedules[key]?.reviews).toBe(1);
  await phone.getByRole("button", { name: "Next" }).tap();
});

test("sends a reply or a marking again when its answer was lost, taking it once", async ({
  browser,
}) => {
  // Without the service worker, which would keep the page's requests from the test.
  const other = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LEARNING_PORT}`,
    serviceWorkers: "block",
  });
  const page = await other.newPage();
  await page.goto(`/practice/review?token=${token()}`);
  await expect(page.locator(".learn-sync")).toHaveText("Saved");
  const key = await cardShown(page);
  await page.getByRole("button", { name: "Answer in my own words" }).tap();
  await page.getByLabel("Your answer, in your own words").fill("It holds");
  await page.getByRole("button", { name: "Go deeper" }).tap();
  const deeper = page.getByRole("region", { name: "Follow-up questions" });
  await expect(deeper.getByRole("heading")).toHaveText("Follow-up question 1 of 2");

  // The reply reaches the server, which asks the next question, but the answer is lost, as is
  // the look at where things stand that follows.
  const lose = async (pattern: string, method: string) => {
    let lost = false;
    await page.route(pattern, async (route) => {
      if (lost || route.request().method() !== method) return route.fallback();
      lost = true;
      if (method === "POST") await route.fetch();
      await route.abort("connectionreset");
    });
  };
  await lose("**/follow-ups/reply", "POST");
  await lose(`**/api/cards/${key}/follow-ups`, "GET");
  await deeper.getByLabel("Your answer").fill("because it does");
  await deeper.getByRole("button", { name: "Answer", exact: true }).tap();
  await expect(deeper.getByRole("alert")).toBeVisible();
  await expect(deeper.getByRole("heading")).toHaveText("Follow-up question 1 of 2");
  await expect(deeper.getByLabel("Your answer")).toHaveValue("because it does");
  // Sent again, it's taken as the answer to the first question, never the second.
  const answer = deeper.getByRole("button", { name: "Answer", exact: true });
  await expect(answer).toBeEnabled({ timeout: 10_000 });
  await answer.tap();
  await expect(deeper.getByRole("heading")).toHaveText("Follow-up question 2 of 2");
  const kept = await serverFollowUps(key);
  expect(kept?.questions.map((q) => q.reply?.text ?? null)).toEqual(["because it does", null]);

  await deeper.getByLabel("Your answer").fill("because it must");
  await deeper.getByRole("button", { name: "Answer", exact: true }).tap();
  await expect(deeper).toContainText("That's all its questions.");
  // Marked, but the marks are lost on their way: asked again, it's the same marks, once.
  await lose("**/follow-ups/finish", "POST");
  await deeper.getByRole("button", { name: "Mark my answers" }).tap();
  await expect(deeper.getByRole("alert")).toBeVisible();
  const mark = deeper.getByRole("button", { name: "Mark my answers" });
  await expect(mark).toBeEnabled({ timeout: 10_000 });
  await mark.tap();
  await expect(page.getByRole("region", { name: "Marked" })).toContainText("90%");
  await page.unrouteAll();
  expect((await serverDeck()).schedules[key]?.reviews).toBe(1);
  await page.getByRole("button", { name: "Next" }).tap();
  await other.close();
});

test("carries on with follow-ups started elsewhere, through a failed look, offline and back", async ({
  browser,
}) => {
  await phone.goto("/practice/review");
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  const first = await cardShown();
  const deck = await serverDeck();
  const other = deck.items.find(
    (item) =>
      item.kind === "card" &&
      item.key !== first &&
      !deck.schedules[item.key] &&
      !deck.flags[item.key],
  );
  if (!other) throw new Error("the review track has no other new card left");
  const key = other.key;

  // Started on another device, it comes first here once the phone hears of it, even though
  // the step was chosen from the deck the phone had.
  await startElsewhere(key, "Started on the laptop");
  await phone.reload();
  await expect.poll(cardShown).toBe(key);
  const deeper = phone.getByRole("region", { name: "Follow-up questions" });
  await expect(deeper.locator(".design-turn.learner").first()).toHaveText("Started on the laptop");

  // When looking for them fails, it says so, and they can be looked for again. Without the
  // service worker, which would keep the page's requests from the test.
  const elsewhere = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LEARNING_PORT}`,
    serviceWorkers: "block",
  });
  const page = await elsewhere.newPage();
  let failed = false;
  await page.route(`**/api/cards/${key}/follow-ups`, async (route) => {
    if (failed || route.request().method() !== "GET") return route.fallback();
    failed = true;
    await route.fulfill({ status: 500, json: { error: "The disk is full" } });
  });
  await page.goto(`/practice/review?token=${token()}`);
  await expect(page.getByRole("alert")).toContainText(
    "Couldn't load your follow-up questions: The disk is full",
  );
  await page.getByRole("button", { name: "Try again" }).tap();
  await expect(
    page.getByRole("region", { name: "Follow-up questions" }).locator(".design-turn.coach"),
  ).toBeVisible();
  await elsewhere.close();

  // Offline, they need the server, and the card can be answered as usual meanwhile. Back
  // online, what's being written isn't taken from under the learner; going deeper carries on
  // with those under way.
  await setOffline(context, true);
  await phone.reload();
  expect(await cardShown()).toBe(key);
  await expect(phone.getByRole("status").filter({ hasText: "under way" })).toContainText(
    "they need the server",
  );
  await phone.getByRole("button", { name: "Answer in my own words" }).tap();
  await expect(phone.getByRole("button", { name: "Go deeper" })).toBeDisabled();
  await expect(phone.getByRole("button", { name: "Mark my answer" })).toBeDisabled();
  await expect(phone.getByText("Marking it, and going deeper, need the server.")).toBeVisible();
  await phone.getByLabel("Your answer, in your own words").fill("Written on the train");
  await setOffline(context, false);
  await expect(phone.getByRole("button", { name: "Go deeper" })).toBeEnabled();
  await expect(deeper).toHaveCount(0);
  await expect(phone.getByLabel("Your answer, in your own words")).toHaveValue(
    "Written on the train",
  );
  await phone.getByRole("button", { name: "Go deeper" }).tap();
  await expect(deeper.getByRole("status")).toContainText(
    "started follow-up questions on this card",
  );
  await expect(deeper.locator(".design-turn.learner").first()).toHaveText("Started on the laptop");

  // Offline again, it's rated as usual, which ends them once it reaches the server.
  await setOffline(context, true);
  await phone.reload();
  expect(await cardShown()).toBe(key);
  await phone.getByRole("button", { name: "Show answer" }).tap();
  await phone.getByRole("button", { name: "Hard" }).tap();
  await expect(phone.locator(".learn-sync")).toHaveText("Offline · 1 to sync");
  await setOffline(context, false);
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  expect((await serverDeck()).schedules[key]?.reviews).toBe(1);
  await expect.poll(followedUp).toEqual([]);
  expect(await serverFollowUps(key)).toBeNull();
});

test("offers no follow-ups on a card that doesn't want them", async ({ browser }) => {
  // Without the service worker, which would keep the page's requests from the test.
  const other = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LEARNING_PORT}`,
    serviceWorkers: "block",
  });
  const page = await other.newPage();
  // Every card is made one with `follow_ups = 0`, as the server would send it.
  await page.route("**/api/learning/sync*", async (route) => {
    const response = await route.fetch();
    const deck = (await response.json()) as Deck & { items: { follow_ups?: number }[] };
    for (const item of deck.items) item.follow_ups = 0;
    await route.fulfill({ response, json: deck });
  });
  await page.goto(`/practice/review?token=${token()}`);
  await expect(page.locator(".learn-sync")).toHaveText("Saved");
  await page.getByRole("button", { name: "Answer in my own words" }).tap();
  await expect(page.getByRole("button", { name: "Mark my answer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Go deeper" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show answer" })).toHaveClass(/pill/);
  await page.reload();
  await page.getByRole("button", { name: "Explain it aloud" }).tap();
  await expect(page.getByRole("region", { name: "Explain it aloud" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Go deeper" })).toHaveCount(0);
  // The sync as the page opened again may still be in the route, whose response would be gone
  // from under it if the context closed first.
  await page.unrouteAll({ behavior: "wait" });
  await other.close();
});

test("answers a card as usual once its follow-ups end elsewhere, after going deeper aloud", async () => {
  await phone.goto("/practice/review");
  await expect(phone.locator(".learn-sync")).toHaveText("Saved");
  const key = await cardShown();
  await phone.getByRole("button", { name: "Explain it aloud" }).tap();
  const explain = phone.getByRole("region", { name: "Explain it aloud" });
  await holdToTalk(
    phone,
    explain.getByRole("button", { name: "Hold to explain" }),
    "it depends",
    () => expect(explain.locator(".dictate-hearing")).toContainText("depends"),
  );
  await explain.getByRole("button", { name: "Go deeper" }).tap();
  const deeper = phone.getByRole("region", { name: "Follow-up questions" });
  await expect(deeper.locator(".design-turn.coach")).toBeVisible();
  // Rated on another device meanwhile, which ends them.
  const rated = await phone.request.post("/api/learning/sync", {
    data: {
      attempts: [
        {
          id: crypto.randomUUID(),
          item: key,
          answered_at: Date.now(),
          duration_ms: 1000,
          rating: "good",
        },
      ],
    },
  });
  expect(rated.ok()).toBe(true);
  await deeper.getByRole("button", { name: "Type it" }).tap();
  await deeper.getByLabel("Your answer").fill("still depends");
  await deeper.getByRole("button", { name: "Answer", exact: true }).tap();
  // It says why, and the card can be answered as usual, with nothing left waiting.
  await expect(phone.getByRole("status").filter({ hasText: "answered another way" })).toBeVisible();
  await expect(deeper).toHaveCount(0);
  const show = phone.getByRole("button", { name: "Show answer" });
  await expect(show).toBeEnabled();
  await phone.getByRole("button", { name: "Answer in my own words" }).tap();
  await phone.getByLabel("Your answer, in your own words").fill("It depends on the keys");
  await expect(phone.getByRole("button", { name: "Mark my answer" })).toBeEnabled();
  await expect(phone.getByRole("button", { name: "Show answer" })).toBeEnabled();
});

test("runs a timed round with the examiner, carrying on after a reload and a break, until time's up", async ({
  browser,
}) => {
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

  // If ending and marking fails mid-round, the error is shown beside the button rather than lost.
  // Without the service worker, which would keep the page's requests from the test.
  const withoutSw = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LEARNING_PORT}`,
    serviceWorkers: "block",
  });
  const endPage = await withoutSw.newPage();
  await endPage.route(
    "**/api/rounds/sample/two-dice-seven/end",
    (route) => route.fulfill({ status: 500, json: { error: "Model unavailable" } }),
    { times: 1 },
  );
  await endPage.goto(`/rounds/sample/two-dice-seven?token=${token()}`);
  await endPage.getByRole("button", { name: "End and mark it" }).tap();
  await expect(endPage.getByRole("alert")).toContainText("Model unavailable");
  await withoutSw.close();

  // The working's saved as it goes, with the clock: a reload carries on where it was.
  await expect.poll(() => serverWork("two-dice-seven")).toBe("6 of the 36 pairs add up to 7");
  await phone.reload();
  await expect(phone.getByLabel("Your working")).toHaveValue("6 of the 36 pairs add up to 7");
  await expect(examiner.locator(".design-turn")).toHaveCount(2);
  await expect(timer).toHaveText(/^9:\d\d$/);
  await expect(phone.getByText(/Welcome back/)).toHaveCount(0);

  // Paused, and back ten minutes later: the clock stopped while the app was closed. Leaving the
  // round sends the working once more, and the server would save the round over the change
  // below if it were still on its way, so every beat is waited for.
  const isBeat = (request: Request) => request.url().endsWith("/two-dice-seven/beat");
  const beats = new Set<Request>();
  const beatSent = (request: Request) => isBeat(request) && beats.add(request);
  const beatDone = (request: Request) => beats.delete(request);
  phone.on("request", beatSent);
  phone.on("requestfinished", beatDone);
  phone.on("requestfailed", beatDone);
  const leaving = phone.waitForRequest(isBeat);
  await phone.getByRole("button", { name: "Pause" }).tap();
  await expect(phone).toHaveURL(/\/rounds$/);
  await expect(phone.getByRole("region", { name: "Under way" })).toContainText(/left of 10/);
  await leaving;
  await expect.poll(() => beats.size).toBe(0);
  phone.off("request", beatSent);
  phone.off("requestfinished", beatDone);
  phone.off("requestfailed", beatDone);
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

test("keeps form fields at least 16px on iOS WebKit and offsets sticky round bar below the safe area", async () => {
  await phone.goto("/");
  const result = await phone.evaluate(() => {
    // Playwright's desktop WebKit does not advertise iOS's -webkit-touch-callout, so when it
    // doesn't, mirror the bundled `@supports (-webkit-touch-callout: none)` rules directly to
    // verify the cascade as iOS Safari evaluates it.
    let supportsCss = "";
    let roundBarTop: string | null = null;
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (
          rule instanceof CSSSupportsRule &&
          rule.conditionText.includes("-webkit-touch-callout")
        ) {
          for (const inner of rule.cssRules) supportsCss += `${inner.cssText}\n`;
        }
        if (rule instanceof CSSStyleRule && rule.selectorText === ".round-bar") {
          roundBarTop = rule.style.top;
        }
      }
    }

    const simulated = document.createElement("style");
    if (!CSS.supports("-webkit-touch-callout", "none")) {
      simulated.textContent = supportsCss;
      document.head.appendChild(simulated);
    }

    // WebKit on macOS sizes a native menu to the system's controls, whatever the stylesheet says,
    // which iOS doesn't do, so the select is measured without its native appearance.
    const probe = document.createElement("div");
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    probe.innerHTML = `
      <textarea class="written"></textarea>
      <textarea class="coding-plan"></textarea>
      <div class="diff"><div class="diff-comment-box"><textarea></textarea></div></div>
      <div class="design-component"><input type="text"></div>
      <div class="design-deep-dive"><select style="appearance: none"><option>a</option></select></div>
      <div class="project-search"><input type="text"></div>
      <div class="project-add"><input type="text"></div>
      <textarea class="bench-keyboard"></textarea>
    `;
    document.body.appendChild(probe);
    const selectors = [
      ".written",
      ".coding-plan",
      ".diff-comment-box textarea",
      ".design-component input",
      ".design-deep-dive select",
      ".project-search input",
      ".project-add input",
      ".bench-keyboard",
    ];
    const sizes: Record<string, number> = {};
    for (const sel of selectors) {
      const el = probe.querySelector(sel);
      if (!el) throw new Error(`missing probe element ${sel}`);
      sizes[sel] = Number.parseFloat(getComputedStyle(el).fontSize);
    }
    probe.remove();
    simulated.remove();
    return { hasSupportsRule: supportsCss.length > 0, sizes, roundBarTop };
  });

  expect(result.hasSupportsRule).toBe(true);
  for (const [sel, size] of Object.entries(result.sizes)) {
    expect(size, sel).toBeGreaterThanOrEqual(16);
  }
  expect(result.roundBarTop).toContain("env(safe-area-inset-top");
});

test("brings a forgotten item back in a later step, never straight away as the next item", async ({
  browser,
}) => {
  // Without the service worker, so the initial deck can start fresh without touching the server's
  // state, then run offline against the app's own scheduling while advancing the clock.
  const other = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${LEARNING_PORT}`,
    serviceWorkers: "block",
  });
  const page = await other.newPage();
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    let shift = 0;
    Date.now = () => realNow() + shift;
    Object.assign(window, {
      advanceMinutes: (minutes: number) => {
        shift += minutes * 60_000;
      },
    });
  });
  const advanceMinutes = (minutes: number) =>
    page.evaluate(
      (m) => (window as unknown as { advanceMinutes: (n: number) => void }).advanceMinutes(m),
      minutes,
    );
  await page.route("**/api/learning/sync*", async (route) => {
    const response = await route.fetch();
    const deck = (await response.json()) as Deck & { follow_ups?: string[] };
    deck.schedules = {};
    deck.flags = {};
    deck.retirements = {};
    deck.follow_ups = [];
    await route.fulfill({ response, json: deck });
  });

  // Visit Home first so its snapshot is cached for offline navigation to Probability below, then
  // open Review to fetch the fresh deck.
  await page.goto(`/?token=${token()}`);
  await expect(page.locator(".track", { hasText: "Review" })).toBeVisible();
  await page.locator(".track", { hasText: "Review" }).tap();
  await expect(page.locator(".learn-sync")).toHaveText("Saved");
  await page.unrouteAll({ behavior: "wait" });
  await setOffline(other, true);

  // Step 1 (three cards): rate the first Forgot, advance past the 10-minute minimum interval so
  // it is already due again by the end of step 1, then finish the step.
  await expect(page.locator(".learn-count")).toHaveText(/^\d+ of \d+ minutes this week$/);
  const forgotten = await cardShown(page);
  await page.getByRole("button", { name: "Show answer" }).tap();
  await page.getByRole("button", { name: "Forgot" }).tap();
  await expect(page.locator(".learn-count")).toHaveText(/^1 done · /);
  await page.getByRole("button", { name: "Show answer" }).tap();
  await page.getByRole("button", { name: "Good" }).tap();
  await advanceMinutes(11);
  await page.getByRole("button", { name: "Show answer" }).tap();
  await page.getByRole("button", { name: "Good" }).tap();

  // Step 2: the forgotten card was in step 1, so it does not come straight back.
  await expect(page.locator(".learn-count")).toHaveText(/^3 done · /);
  const stepTwo: string[] = [];
  for (let i = 0; i < 3; i++) {
    const key = await cardShown(page);
    expect(key).not.toBe(forgotten);
    stepTwo.push(key);
    await page.getByRole("button", { name: "Show answer" }).tap();
    await page.getByRole("button", { name: "Good" }).tap();
  }

  // Step 3: now that another step has passed, the forgotten card comes back first.
  await expect(page.locator(".learn-count")).toHaveText(/^6 done · /);
  expect(await cardShown(page)).toBe(forgotten);
  await page.getByRole("button", { name: "Show answer" }).tap();
  await page.getByRole("button", { name: "Good" }).tap();
  await expect(page.locator(".learn-count")).toHaveText(/^7 done · /);
  expect(await cardShown(page)).not.toBe(forgotten);
  expect(stepTwo).not.toContain(forgotten);

  // A single-item step (probability, 3 minutes) answered wrong and already due by the time the
  // learner taps Next must not come straight back as the very next item, then comes back after
  // the next question.
  await page.getByRole("banner").getByRole("button", { name: "Home" }).tap();
  await page.locator(".track", { hasText: "Probability" }).tap();
  await expect(page.locator(".learn-count")).toHaveText(/^\d+ of \d+ minutes this week$/);
  const missed = await shown(page);
  await page.getByRole("button", { name: "I don't know" }).tap();
  await advanceMinutes(11);
  await page.getByRole("button", { name: "Next" }).tap();
  await expect(page.locator(".learn-count")).toHaveText(/^1 done · /);
  const afterMissed = await shown(page);
  expect(afterMissed.key).not.toBe(missed.key);
  await answer(afterMissed.answer, page);
  await page.getByRole("button", { name: "Got it" }).tap();
  await expect(page.locator(".learn-count")).toHaveText(/^2 done · /);
  expect((await shown(page)).key).toBe(missed.key);

  await other.close();
});
