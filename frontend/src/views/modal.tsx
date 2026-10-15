import type { ComponentChildren } from "preact";
import { useLayoutEffect } from "preact/hooks";
import { useCloseOnBack } from "../hooks/useCloseOnBack";

/**
 * How a modal sits on the screen: a centred `card`; `full`, filling the screen on phones, for
 * longer content such as settings; or a `sheet` along the bottom, within reach of the thumb.
 */
export type ModalShape = "card" | "full" | "sheet";

/**
 * A dialog above everything else, over a dimmed, blurred background, closed by tapping outside,
 * Escape or going back. With `onBack`, it's showing a page within itself: the header has a back
 * button, and Escape goes back rather than closing.
 */
export function Modal({
  title,
  onClose,
  onBack,
  shape = "card",
  children,
}: {
  title: string;
  onClose: () => void;
  onBack?: (() => void) | undefined;
  shape?: ModalShape;
  children: ComponentChildren;
}) {
  useCloseOnBack(onClose);

  // Before the dialog is shown, so Escape works as soon as it can be seen.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") (onBack ?? onClose)();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onBack]);

  return (
    <div class={`modal-backdrop ${shape}`}>
      {/* Tapping outside closes it; the ✕ and Escape are there for everyone else. */}
      <button
        type="button"
        class="modal-dismiss"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <div class="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div class="sheet-header">
          {onBack ? (
            <button type="button" class="icon-button back" aria-label="Back" onClick={onBack}>
              ‹
            </button>
          ) : null}
          <h1>{title}</h1>
          <button type="button" class="icon-button" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div class="sheet-body">{children}</div>
      </div>
    </div>
  );
}
