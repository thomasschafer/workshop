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
      <ul class="marked-points">
        {marked.points.map((point) => (
          <li key={point.point} class={`marked-point ${point.met}`}>
            <span class="marked-met">{MET[point.met]}</span>
            <span>{point.point}</span>
            {point.comment ? <span class="muted">{point.comment}</span> : null}
          </li>
        ))}
      </ul>
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
