import type { ComponentChildren } from "preact";
import { useCloseOnBack } from "../hooks/useCloseOnBack";

/** A panel that slides up over the content, closed by its button or going back. */
export function SheetFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  useCloseOnBack(onClose);
  return (
    <div class="sheet">
      <div class="sheet-header">
        <h1>{title}</h1>
        <button type="button" class="icon-button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div class="sheet-body">{children}</div>
    </div>
  );
}

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
