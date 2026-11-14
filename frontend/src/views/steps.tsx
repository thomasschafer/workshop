import "./steps.css";

/**
 * The steps of something done a step at a time, such as a coding problem or a design session:
 * the one the learner is at, and those they can go back to.
 */
export function StepNav<S extends string>({
  title,
  steps,
  current,
  label,
  reachable,
  onGo,
}: {
  title: string;
  steps: readonly S[];
  current: S;
  label: (step: S) => string;
  reachable: (step: S) => boolean;
  onGo: (step: S) => void;
}) {
  return (
    <nav class="steps" aria-label="Steps">
      <h1 class="steps-title">{title}</h1>
      <ol>
        {steps.map((step) => (
          <li key={step}>
            <button
              type="button"
              class={`step ${step === current ? "current" : ""}`}
              aria-current={step === current ? "step" : undefined}
              disabled={!reachable(step)}
              onClick={() => onGo(step)}
            >
              {label(step)}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
