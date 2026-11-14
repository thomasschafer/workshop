import { Page } from "../progress/page";
import { FlaggedCards } from "./flagged";
import "./pack.css";

/** The packs: items flagged as wrong, and keeping the packs up to date. */
export function PackScreen({ onHome }: { onHome: () => void }) {
  return (
    <Page title="Packs" onHome={onHome}>
      <FlaggedCards />
    </Page>
  );
}
