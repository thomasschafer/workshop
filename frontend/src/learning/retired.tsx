/**
 * The items of a track that were found too easy and retired, each with a button to bring it
 * back, as the Coding track and the tracks of short items show them.
 */
export function RetiredList({
  items,
  bringing = null,
  disabled = false,
  error = null,
  onBringBack,
}: {
  items: { key: string; label: string }[];
  /** The item being brought back, while that's under way. */
  bringing?: string | null;
  disabled?: boolean;
  error?: string | null;
  onBringBack: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section class="retired" aria-labelledby="retired-heading">
      <h2 id="retired-heading" class="retired-heading">
        Retired
      </h2>
      <p class="muted retired-hint">
        Found too easy, so they won't come back. Bring one back to have it reviewed again.
      </p>
      <ul class="retired-items">
        {items.map((item) => (
          <li key={item.key} class="retired-item">
            <span class="retired-name">{item.label}</span>
            <button
              type="button"
              class="pill"
              disabled={disabled || bringing !== null}
              onClick={() => onBringBack(item.key)}
            >
              {bringing === item.key ? "Bringing back…" : "Bring back"}
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p class="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
