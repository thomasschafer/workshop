import { useState } from "preact/hooks";
import { useUpdateReady } from "../update";

/** Offers to reload once a new release of the app has taken over, until it's dismissed. */
export function UpdateCard() {
  const ready = useUpdateReady();
  const [dismissed, setDismissed] = useState(false);
  if (!ready || dismissed) return null;
  return (
    <div class="update-card" role="status">
      <span>Workshop has been updated.</span>
      <button type="button" class="pill primary" onClick={() => location.reload()}>
        Reload
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Reload later"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  );
}
