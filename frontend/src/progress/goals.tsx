import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { getSnapshot, putSnapshot } from "../offline/db";
import { progressApi } from "./api";
import { Loading, Page } from "./page";
import type { GoalProgress, SkillProgress } from "./types";

const GOALS_SNAPSHOT_KEY = "goals";

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** The packs' goals, or one of them, by id: how close each is to its target. */
export function GoalsScreen({
  goal,
  onHome,
  onOpen,
}: {
  goal: string | null;
  onHome: () => void;
  /** Opens a goal, or the list for null. */
  onOpen: (goal: string | null) => void;
}) {
  const [goals, setGoals] = useState<GoalProgress[] | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let fetchedFresh = false;
    setError(null);
    setStale(false);
    const cacheReady = getSnapshot<GoalProgress[]>(GOALS_SNAPSHOT_KEY).then((cached) => {
      if (cancelled || !cached || fetchedFresh) return Boolean(cached);
      setGoals(cached.value);
      return true;
    });
    progressApi.goals().then(
      (loaded) => {
        if (cancelled) return;
        fetchedFresh = true;
        setGoals(loaded);
        setStale(false);
        void putSnapshot(GOALS_SNAPSHOT_KEY, loaded);
      },
      async (e: unknown) => {
        const hasCached = await cacheReady;
        if (cancelled) return;
        if (hasCached) setStale(true);
        else setError(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (goals === null) {
    return (
      <Page title="Goals" onHome={onHome}>
        <Loading error={error} onRetry={() => setAttempt((n) => n + 1)} />
      </Page>
    );
  }
  const shown = goal === null ? undefined : goals.find((g) => g.id === goal);
  if (shown) {
    return (
      <Page title={shown.name} onHome={onHome}>
        {stale ? (
          <p class="muted" role="status">
            Showing the last goals saved on this device.
          </p>
        ) : null}
        <GoalView goal={shown} />
        <button type="button" class="pill" onClick={() => onOpen(null)}>
          Every goal
        </button>
      </Page>
    );
  }
  return (
    <Page title="Goals" onHome={onHome}>
      {stale ? (
        <p class="muted" role="status">
          Showing the last goals saved on this device.
        </p>
      ) : null}
      {goal !== null ? <p class="muted">There's no goal called {goal} in your packs.</p> : null}
      {goals.length === 0 ? (
        <p class="empty">
          Your packs have no goals yet. A goal is a set of skills to master, in a pack's pack.toml.
        </p>
      ) : (
        <ul class="tracks">
          {goals.map((g) => (
            <li key={`${g.pack}/${g.id}`}>
              <button type="button" class="home-link" onClick={() => onOpen(g.id)}>
                <span class="home-link-name">{g.name}</span>
                <span class="home-link-summary">
                  {percent(g.progress)} of the way{g.by ? ` · by ${g.by}` : ""}
                </span>
                <meter
                  class="meter"
                  aria-label={`${g.name} progress`}
                  min={0}
                  max={1}
                  value={g.progress}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

/** The coverage a goal asks for, which goals saved by an older Workshop didn't say. */
const coverageTarget = (goal: GoalProgress) => goal.coverage_target ?? goal.target;

/** How a skill stands, in a few words that fit a phone. */
function standing(skill: SkillProgress): string {
  const recall = `recall ${percent(skill.mastery)}`;
  if (skill.coverage === undefined) return recall;
  if ((skill.covered ?? 0) === 0) {
    return skill.mastery > 0 ? `Nothing covered yet · ${recall}` : "Nothing covered yet";
  }
  return `${percent(skill.coverage)} covered · ${recall}`;
}

/** What's behind a skill's coverage, and how many of its items have been tried. */
function counts(skill: SkillProgress): string {
  const items = `${skill.attempted} of ${skill.items} ${skill.items === 1 ? "item" : "items"} tried`;
  const topics = skill.topics ?? 0;
  if (topics > 0) {
    return `${skill.covered ?? 0} of ${topics} ${topics === 1 ? "topic" : "topics"} covered · ${items}`;
  }
  return items;
}

function GoalView({ goal }: { goal: GoalProgress }) {
  const name = (id: string) => goal.skills.find((s) => s.id === id)?.name ?? id;
  const due =
    goal.days_left === null
      ? null
      : goal.days_left < 0
        ? `It was wanted by ${goal.by}`
        : goal.days_left === 0
          ? "It's wanted by today"
          : `${goal.days_left} ${goal.days_left === 1 ? "day" : "days"} left, to ${goal.by}`;
  const targets =
    coverageTarget(goal) === goal.target
      ? `Each skill ${percent(goal.target)} covered and recalled`
      : `Each skill ${percent(coverageTarget(goal))} covered, recall ${percent(goal.target)}`;
  return (
    <>
      <section class="goal-summary" aria-label="Summary">
        <p class="goal-headline">{percent(goal.progress)} of the way</p>
        <p class="muted">
          {targets}
          {due ? ` · ${due}` : ""} · {goal.pack}
        </p>
      </section>
      <section aria-labelledby="trend-heading">
        <h2 id="trend-heading" class="tracks-heading">
          The last {goal.trend.length - 1} weeks
        </h2>
        <Trend goal={goal} />
      </section>
      <section aria-labelledby="skills-heading">
        <h2 id="skills-heading" class="tracks-heading">
          Skills
        </h2>
        <ul class="progress-list goal-skills">
          {goal.skills.map((skill) => (
            <li key={skill.id} class="goal-skill">
              <span class="goal-skill-name">
                <span>{skill.name}</span>
                {skill.met ? <span class="muted">there</span> : null}
              </span>
              <span class="goal-skill-standing">{standing(skill)}</span>
              {skill.coverage === undefined || (skill.covered ?? 0) > 0 ? (
                <span class="goal-meters">
                  {skill.coverage === undefined ? null : (
                    <SkillMeter
                      measure="coverage"
                      label="Covered"
                      name={`${skill.name} covered`}
                      value={skill.coverage}
                      target={coverageTarget(goal)}
                    />
                  )}
                  <SkillMeter
                    measure="recall"
                    label="Recall"
                    name={`${skill.name} recall`}
                    value={skill.mastery}
                    target={goal.target}
                  />
                </span>
              ) : null}
              <span class="muted goal-skill-items">{counts(skill)}</span>
            </li>
          ))}
        </ul>
      </section>
      {goal.weakest.length > 0 ? (
        <section aria-labelledby="weakest-heading">
          <h2 id="weakest-heading" class="tracks-heading">
            Weakest
          </h2>
          <p class="goal-weakest">{goal.weakest.map(name).join(", ")}</p>
        </section>
      ) : null}
      {goal.mistakes.length > 0 ? (
        <section aria-labelledby="goal-mistakes-heading">
          <h2 id="goal-mistakes-heading" class="tracks-heading">
            Recent mistakes, by kind
          </h2>
          <ul class="progress-counts">
            {goal.mistakes.map((m) => (
              <li key={m.error_type}>
                <span>{m.error_type.replaceAll("-", " ")}</span>
                <span class="muted">{m.count}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** One of a skill's measures, as a meter with the goal's target marked across it. */
function SkillMeter({
  measure,
  label,
  name,
  value,
  target,
}: {
  /** Which it is, for its colour, the same as its line in the trend. */
  measure: "coverage" | "recall";
  label: string;
  name: string;
  value: number;
  target: number;
}) {
  return (
    <>
      <span class="muted goal-meter-label" aria-hidden="true">
        {label}
      </span>
      <span class="goal-meter">
        <meter
          class={`meter goal-meter-${measure}`}
          aria-label={name}
          min={0}
          max={1}
          value={value}
        />
        <span class="goal-target" style={{ left: percent(target) }} />
      </span>
    </>
  );
}

const WIDTH = 320;
const HEIGHT = 96;
const PAD = 6;

/** The goal's average coverage and recall each week, as lines, with the targets dashed across. */
function Trend({ goal }: { goal: GoalProgress }) {
  const points = goal.trend;
  const x = (i: number) => PAD + (i / Math.max(1, points.length - 1)) * (WIDTH - 2 * PAD);
  const y = (share: number) => HEIGHT - PAD - share * (HEIGHT - 2 * PAD);
  const hasCoverage = points.every((p) => p.coverage !== undefined);
  type Measure = (p: (typeof points)[number]) => number;
  const start = (measure: Measure) => percent(points[0] ? measure(points[0]) : 0);
  const end = (measure: Measure) => {
    const last = points[points.length - 1];
    return percent(last ? measure(last) : 0);
  };
  const from = (measure: Measure) => `${end(measure)}, from ${start(measure)}`;
  const line = (measure: Measure) => points.map((p, i) => `${x(i)},${y(measure(p))}`).join(" ");
  const recall: Measure = (p) => p.mastery;
  const coverage: Measure = (p) => p.coverage ?? 0;
  // Each target dashed in its measure's colour, or one line in neither when they're the same.
  const targets: { share: number; measure: "coverage" | "recall" | "both" }[] =
    hasCoverage && coverageTarget(goal) !== goal.target
      ? [
          { share: coverageTarget(goal), measure: "coverage" },
          { share: goal.target, measure: "recall" },
        ]
      : [{ share: goal.target, measure: hasCoverage ? "both" : "recall" }];
  const week = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const label = hasCoverage
    ? `Average coverage went from ${start(coverage)} to ${end(coverage)}, and recall from ${start(recall)} to ${end(recall)}, against targets of ${percent(coverageTarget(goal))} covered and ${percent(goal.target)} recall`
    : `Average recall went from ${start(recall)} to ${end(recall)}, against a target of ${percent(goal.target)}`;
  return (
    <figure class="goal-trend">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label}>
        {targets.map((target) => (
          <line
            key={target.measure}
            class={`goal-trend-target goal-trend-target-${target.measure}`}
            x1={PAD}
            x2={WIDTH - PAD}
            y1={y(target.share)}
            y2={y(target.share)}
          />
        ))}
        <polyline class="goal-trend-line goal-trend-recall" points={line(recall)} />
        {hasCoverage ? (
          <polyline class="goal-trend-line goal-trend-coverage" points={line(coverage)} />
        ) : null}
        {points.map((p, i) => (
          <circle
            key={p.at}
            class={i === points.length - 1 ? "goal-trend-now" : "goal-trend-point"}
            cx={x(i)}
            cy={y(hasCoverage ? coverage(p) : recall(p))}
            r={i === points.length - 1 ? 4 : 8}
          >
            <title>
              {week(p.at)}:{hasCoverage ? ` ${percent(coverage(p))} covered,` : ""} recall{" "}
              {percent(recall(p))}
            </title>
          </circle>
        ))}
      </svg>
      <figcaption class="muted">
        {hasCoverage ? (
          <>
            <span class="goal-key goal-key-coverage" aria-hidden="true" />
            Covered {from(coverage)}
            <br />
          </>
        ) : null}
        <span class="goal-key goal-key-recall" aria-hidden="true" />
        Recall {from(recall)}
        <br />
        {targets.length === 1
          ? "The dashed line is the target."
          : "The dashed lines are their targets, in their colours."}
      </figcaption>
      <table class="visually-hidden">
        <caption>Average coverage and recall by week</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            {hasCoverage ? <th scope="col">Covered</th> : null}
            <th scope="col">Recall</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.at}>
              <th scope="row">{week(p.at)}</th>
              {hasCoverage ? <td>{percent(coverage(p))}</td> : null}
              <td>{percent(recall(p))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
