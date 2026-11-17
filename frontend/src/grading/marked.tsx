import { Markdown } from "../learning/practice";
import "./grading.css";
import type { Marked } from "./types";

const MET = { yes: "Met", partly: "Partly", no: "Not met" } as const;

/** How the grader marked a piece of work: the score, each rubric point, what it found wrong and
 * what to do next. */
export function MarkedView({ marked }: { marked: Marked }) {
  return (
    <section class="marked" aria-label="Marked">
      <p class="marked-score">{Math.round(marked.score * 100)}%</p>
      <Markdown text={marked.feedback} />
      {marked.clarity ? (
        <section class="marked-clarity" aria-label="Clarity">
          <h3 class="tracks-heading">
            How clearly you put it: {Math.round(marked.clarity.score * 100)}%
          </h3>
          <Markdown text={marked.clarity.feedback} />
        </section>
      ) : null}
      <ul class="marked-points">
        {marked.points.map((point) => (
          <li key={point.point} class={`marked-point ${point.met}`}>
            <span class="marked-met">{MET[point.met]}</span>
            <span>{point.point}</span>
            {point.comment ? <span class="muted">{point.comment}</span> : null}
          </li>
        ))}
      </ul>
      {marked.questioning ? <QuestioningView questioning={marked.questioning} /> : null}
      {marked.findings.length > 0 ? (
        <>
          <h3 class="tracks-heading">Mistakes, kept in your log</h3>
          <ul class="marked-findings">
            {marked.findings.map((finding) => (
              <li key={finding.detail}>{finding.detail}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** What the learner found out about a design's requirements by asking, and what they didn't. */
function QuestioningView({ questioning }: { questioning: NonNullable<Marked["questioning"]> }) {
  const parts = [
    { title: "Found out", items: questioning.found },
    { title: "Missed, kept in your log", items: questioning.missed },
    { title: "Assumed without asking", items: questioning.assumed },
  ].filter((part) => part.items.length > 0);
  if (parts.length === 0) return null;
  return (
    <section class="marked-questioning" aria-label="What you asked">
      <h3 class="tracks-heading">What you asked</h3>
      {parts.map((part) => (
        <section key={part.title} aria-label={part.title}>
          <h4 class="muted">{part.title}</h4>
          <ul class="marked-findings">
            {part.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
