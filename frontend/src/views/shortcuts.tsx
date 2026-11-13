import { chordLabel, isApple, SHORTCUTS } from "../shortcuts";
import { Modal } from "./modal";

/** Every keyboard shortcut, as this device's keyboard writes them. */
export function ShortcutsModal({ helixOn, onClose }: { helixOn: boolean; onClose: () => void }) {
  const mac = isApple();
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table class="shortcuts">
        <tbody>
          {SHORTCUTS.map(({ id, chord, description }) => (
            <tr key={id}>
              <th>
                <kbd>{chordLabel(chord, mac)}</kbd>
              </th>
              <td>{description}</td>
            </tr>
          ))}
          <tr>
            <th>
              <kbd>Ctrl</kbd>
            </th>
            <td>Hold, on its own, to talk</td>
          </tr>
        </tbody>
      </table>
      <p class="muted small">
        These work anywhere in Workshop.{" "}
        {helixOn
          ? "In the code, Helix's keys work as well: Space then ? lists its commands."
          : "In the code, the editor's usual keys work as well."}
      </p>
    </Modal>
  );
}
