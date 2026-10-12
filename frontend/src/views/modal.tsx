import type { ComponentChildren } from "preact";
import { useLayoutEffect } from "preact/hooks";

/** A centred card over a dimmed, blurred background, closed by tapping outside or Escape. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  // Before the dialog is shown, so Escape works as soon as it can be seen.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div class="modal-backdrop">
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
