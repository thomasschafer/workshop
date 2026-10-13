/** Offers a choice when a file changed elsewhere while there were unsaved changes here. */
export function ConflictBanner({
  what,
  onResolve,
}: {
  what: string;
  onResolve: (keep: "mine" | "theirs") => void;
}) {
  return (
    <div class="banner">
      <span>The {what} changed elsewhere.</span>
      <span class="banner-actions">
        <button type="button" class="text-button" onClick={() => onResolve("mine")}>
          Keep mine
        </button>
        <button type="button" class="text-button" onClick={() => onResolve("theirs")}>
          Load theirs
        </button>
      </span>
    </div>
  );
}
