import type { ComponentChildren } from "preact";
import { useLayoutEffect } from "preact/hooks";
import { useCloseOnBack } from "../hooks/useCloseOnBack";

/**
 * A centred card over a dimmed, blurred background, closed by tapping outside, Escape or going
 * back. A `full` modal fills the screen on phones, for longer content such as settings.
 */
export function Modal({
  title,
  onClose,
  full = false,
  children,
}: {
  title: string;
  onClose: () => void;
  full?: boolean;
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
    <div class={`modal-backdrop ${full ? "full" : ""}`}>
      <button type="button" class="modal-dismiss" aria-label="Close" onClick={onClose} />
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
