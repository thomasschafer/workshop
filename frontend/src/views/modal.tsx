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
 * Escape or going back.
 */
export function Modal({
  title,
  onClose,
  shape = "card",
  children,
}: {
  title: string;
  onClose: () => void;
  shape?: ModalShape;
  children: ComponentChildren;
}) {
  useCloseOnBack(onClose);

  // Before the dialog is shown, so Escape works as soon as it can be seen.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
