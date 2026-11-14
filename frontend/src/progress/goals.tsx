import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { progressApi } from "./api";
import { Loading, Page } from "./page";
import type { GoalProgress } from "./types";

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
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    progressApi.goals().then(setGoals, (e: unknown) => setError(errorMessage(e)));
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
        <GoalView goal={shown} />
        <button type="button" class="pill" onClick={() => onOpen(null)}>
          Every goal
        </button>
      </Page>
    );
  }
  return (
    <Page title="Goals" onHome={onHome}>
      {goal !== null ? <p class="muted">There's no goal called {goal} in your packs.</p> : null}
      {goals.length === 0 ? (
        <p class="muted">
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
  return (
    <>
      <section class="goal-summary" aria-label="Summary">
        <p class="goal-headline">{percent(goal.progress)} of the way</p>
        <p class="muted">
          Each skill to {percent(goal.target)} mastered{due ? ` · ${due}` : ""} · {goal.pack}
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
                <span class="muted">
                  {percent(skill.mastery)}
                  {skill.met ? " · there" : ""}
                </span>
              </span>
              <span class="goal-meter">
                <meter
                  class="meter"
                  aria-label={`${skill.name} mastered`}
                  min={0}
                  max={1}
                  value={skill.mastery}
                />
                <span class="goal-target" style={{ left: percent(goal.target) }} />
              </span>
              <span class="muted goal-skill-items">
                {skill.attempted} of {skill.items} {skill.items === 1 ? "item" : "items"} tried
              </span>
            </li>
          ))}
        </ul>
      </section>
      {goal.weakest.length > 0 ? (
        <section aria-labelledby="weakest-heading">
          <h2 id="weakest-heading" class="tracks-heading">
            Weakest
          </h2>
          <p>{goal.weakest.map(name).join(", ")}</p>
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

const WIDTH = 320;
const HEIGHT = 96;
const PAD = 6;

/** The goal's average mastery each week, as a line, with the target dashed across it. */
function Trend({ goal }: { goal: GoalProgress }) {
  const points = goal.trend;
  const x = (i: number) => PAD + (i / Math.max(1, points.length - 1)) * (WIDTH - 2 * PAD);
  const y = (mastery: number) => HEIGHT - PAD - mastery * (HEIGHT - 2 * PAD);
  const line = points.map((p, i) => `${x(i)},${y(p.mastery)}`).join(" ");
  const first = points[0]?.mastery ?? 0;
  const last = points[points.length - 1]?.mastery ?? 0;
  const week = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <figure class="goal-trend">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Average mastery went from ${percent(first)} to ${percent(last)}, against a target of ${percent(goal.target)}`}
      >
        <line
          class="goal-trend-target"
          x1={PAD}
          x2={WIDTH - PAD}
          y1={y(goal.target)}
          y2={y(goal.target)}
        />
        <polyline class="goal-trend-line" points={line} />
        {points.map((p, i) => (
          <circle
            key={p.at}
            class={i === points.length - 1 ? "goal-trend-now" : "goal-trend-point"}
            cx={x(i)}
            cy={y(p.mastery)}
            r={i === points.length - 1 ? 4 : 8}
          >
            <title>
              {week(p.at)}: {percent(p.mastery)}
            </title>
          </circle>
        ))}
      </svg>
      <figcaption class="muted">
        Now {percent(last)}, from {percent(first)}; the dashed line is the target.
      </figcaption>
      <table class="visually-hidden">
        <caption>Average mastery by week</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.at}>
              <th scope="row">{week(p.at)}</th>
              <td>{percent(p.mastery)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
