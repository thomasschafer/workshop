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
type Job = { id: number; name: string; conclusion: string | null; html_url: string };
type Outcome = "failed" | "flaky";
/** The latest time a test failed or needed a retry: when, in which job, and its error. */
type Latest = { at: string; job: string; error: string };
type Tally = { failed: number; flaky: number; jobs: Set<string>; latest: Latest };

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
// Before the summary, each test that failed a try has its error under a numbered heading.
const FAILURE_HEADING = /^ {2}\d+\) \[(\w+)\] › (\S+?):\d+:\d+ › (.+?)\s*(?:─+)?$/;
const PLAYWRIGHT_ERROR = /^\s+((?:\w*Error:|Test timeout).*)$/;
const RUST_PANIC = /^thread '.*'.* panicked at /;
const COLOUR_CODE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** A line short enough to read at a glance; assertions can print whole documents. */
function truncated(line: string, length = 160): string {
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

function testName(match: RegExpExecArray): string {
  // Windows writes the file's path with backslashes.
  return `${match[1]} ${match[2].replaceAll("\\", "/")} › ${match[3]}`;
}

/** What happened to each test in a job's log, and the first error each one gave. */
function outcomes(log: string): { found: [string, Outcome][]; errors: Map<string, string> } {
  const found: [string, Outcome][] = [];
  const errors = new Map<string, string>();
  let section: Outcome | null = null;
  // The test whose error is still to be found, and for a Rust test, whether its panic is next.
  let erring: { test: string; rust: boolean; panicked: boolean } | null = null;
  for (const raw of log.split("\n")) {
    // Each line starts with a timestamp, and some have colour codes.
    const line = raw
      .replace(/^\S+Z /, "")
      .replace(COLOUR_CODE, "")
      .trimEnd();
    if (erring && !errors.has(erring.test)) {
      if (erring.rust && !erring.panicked) {
        erring.panicked = RUST_PANIC.test(line);
      } else if (erring.rust && line.trim() !== "") {
        errors.set(erring.test, line.trim());
        erring = null;
      } else {
        const error = PLAYWRIGHT_ERROR.exec(line);
        if (error) {
          errors.set(erring.test, error[1]);
          erring = null;
        }
      }
    }
    const heading = FAILURE_HEADING.exec(line);
    if (heading) {
      erring = { test: testName(heading), rust: false, panicked: false };
      continue;
    }
    const summary = SUMMARY.exec(line);
    if (summary) {
      section = summary[1] as Outcome;
      continue;
    }
    const test = SUMMARY_TEST.exec(line);
    if (section && test) {
      found.push([testName(test), section]);
      continue;
    }
    section = null;
    const rust = RUST_FAILURE.exec(line);
    if (rust) {
      const test = `rust ${rust[1]}`;
      found.push([test, "failed"]);
      erring = { test, rust: true, panicked: false };
    }
  }
  return { found, errors };
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
    ".jobs[] | {id, name, conclusion, html_url}",
  ])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  for (const job of jobs) {
    if (job.conclusion !== "success" && job.conclusion !== "failure") {
      continue;
    }
    jobsRead += 1;
    const log = gh([
      "api",
      "--allow-escape-sequences",
      `repos/${repo}/actions/jobs/${job.id}/logs`,
    ]);
    const { found, errors } = outcomes(log);
    // A Rust test's failure is printed twice, so each test counts once per job.
    for (const [test, outcome] of new Map(found)) {
      const latest = { at: run.createdAt, job: job.html_url, error: errors.get(test) ?? "" };
      const tally = tallies.get(test) ?? { failed: 0, flaky: 0, jobs: new Set(), latest };
      tally[outcome] += 1;
      tally.jobs.add(job.name);
      if (latest.at > tally.latest.at) tally.latest = latest;
      tallies.set(test, tally);
    }
  }
}

console.log(`${runs.length} runs and ${jobsRead} jobs read.\n`);
if (tallies.size === 0) {
  console.log("No test failed or needed a retry.");
} else {
  const sorted = [...tallies].sort(
    ([, a], [, b]) =>
      b.failed + b.flaky - (a.failed + a.flaky) || b.latest.at.localeCompare(a.latest.at),
  );
  const indent = " ".repeat(39);
  for (const [test, { failed, flaky, jobs, latest }] of sorted) {
    console.log(
      [
        `${String(failed).padStart(3)} failed ${String(flaky).padStart(3)} flaky  last ${latest.at.slice(0, 10)}  ${test}`,
        `${indent}in ${[...jobs].join(", ")}`,
        ...(latest.error ? [`${indent}${truncated(latest.error)}`] : []),
        `${indent}${latest.job}`,
      ].join("\n"),
    );
  }
}
