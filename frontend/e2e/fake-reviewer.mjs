// A stand-in for the author's reviewer, so end-to-end tests call no model. It agrees with every
// item except one whose question is too vague, and objects to an overbroad claim in a lesson until
// revised.
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
if (prompt.startsWith("Solve this")) {
  console.log(JSON.stringify({ answer: "Linear", working: "Each item once", unclear: [] }));
} else if (prompt.startsWith("Audit this lesson")) {
  if (prompt.includes("All fast sorting algorithms are stable")) {
    console.log(
      JSON.stringify({
        agree: false,
        ambiguous: false,
        objection: "Not all fast sorting algorithms are stable; quicksort and heapsort are not.",
      }),
    );
  } else {
    console.log(JSON.stringify({ agree: true, ambiguous: false, objection: "" }));
  }
} else if (prompt.includes("vague-scan.md")) {
  console.log(
    JSON.stringify({ agree: false, ambiguous: true, objection: "A scan of what, and how?" }),
  );
} else {
  console.log(JSON.stringify({ agree: true, ambiguous: false, objection: "" }));
}
