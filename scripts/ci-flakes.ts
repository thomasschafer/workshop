// Lists the tests that failed, or only passed on a retry, across recent CI runs, so flaky tests
// are found and fixed rather than retried for ever. Needs the GitHub CLI, signed in.
//
//   node scripts/ci-flakes.ts              # the last 30 runs
//   node scripts/ci-flakes.ts --runs 100

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { runs: { type: "string", default: "30" } },
});
const runCount = Number(values.runs);
if (!Number.isInteger(runCount) || runCount < 1) {
  throw new Error(`--runs must be a positive whole number, not ${values.runs}`);
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

type Run = { databaseId: number; createdAt: string; displayTitle: string };
type Job = { id: number; name: string; conclusion: string | null };
type Outcome = "failed" | "flaky";
type Tally = { failed: number; flaky: number; jobs: Set<string>; last: string };

const repo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
const runs: Run[] = JSON.parse(
  gh([
    "run",
    "list",
    "--workflow",
    "ci.yml",
    "--limit",
    String(runCount),
    "--json",
    "databaseId,createdAt,displayTitle,status",
    "-q",
    '[.[] | select(.status == "completed")]',
  ]),
);

// Playwright's summary lists each test under the outcome it's counted as, such as "  2 flaky",
// and a failed Rust test has a section of its own output.
const SUMMARY = /^ {2}\d+ (failed|flaky)$/;
const SUMMARY_TEST = /^ {4}\[(\w+)\] › (\S+?):\d+:\d+ › (.+?)\s*(?:─+)?$/;
const RUST_FAILURE = /^---- (\S+) stdout ----$/;

function outcomes(log: string): [string, Outcome][] {
  const found: [string, Outcome][] = [];
  let section: Outcome | null = null;
  for (const raw of log.split("\n")) {
    // Each line starts with a timestamp, and some have colour codes.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removes terminal colour codes
    const line = raw.replace(/^\S+Z /, "").replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
    const summary = SUMMARY.exec(line);
    if (summary) {
      section = summary[1] as Outcome;
      continue;
    }
    const test = SUMMARY_TEST.exec(line);
    if (section && test) {
      found.push([`${test[1]} ${test[2]} › ${test[3]}`, section]);
      continue;
    }
    section = null;
    const rust = RUST_FAILURE.exec(line);
    if (rust) {
      found.push([`rust ${rust[1]}`, "failed"]);
    }
  }
  return found;
}

const tallies = new Map<string, Tally>();
let jobsRead = 0;
for (const run of runs) {
  // One job per line, as JSON, across all the pages.
  const jobs: Job[] = gh([
    "api",
    "--paginate",
    `repos/${repo}/actions/runs/${run.databaseId}/jobs`,
    "-q",
    ".jobs[] | {id, name, conclusion}",
  ])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  for (const job of jobs) {
    if (job.conclusion !== "success" && job.conclusion !== "failure") {
      continue;
    }
    jobsRead += 1;
    const log = gh(["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${job.id}/logs`]);
    // A Rust test's failure is printed twice, so each test counts once per job.
    for (const [test, outcome] of new Map(outcomes(log))) {
      const tally = tallies.get(test) ?? { failed: 0, flaky: 0, jobs: new Set(), last: "" };
      tally[outcome] += 1;
      tally.jobs.add(job.name);
      tally.last = tally.last > run.createdAt ? tally.last : run.createdAt;
      tallies.set(test, tally);
    }
  }
}

console.log(`${runs.length} runs and ${jobsRead} jobs read.\n`);
if (tallies.size === 0) {
  console.log("No test failed or needed a retry.");
} else {
  const sorted = [...tallies].sort(
    ([, a], [, b]) => b.failed + b.flaky - (a.failed + a.flaky) || b.last.localeCompare(a.last),
  );
  for (const [test, tally] of sorted) {
    console.log(
      `${String(tally.failed).padStart(3)} failed ${String(tally.flaky).padStart(3)} flaky  last ${tally.last.slice(0, 10)}  ${test}\n${" ".repeat(39)}in ${[...tally.jobs].join(", ")}`,
    );
  }
}
