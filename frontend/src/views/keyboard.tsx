import { useEffect, useRef, useState } from "preact/hooks";
import type { Key } from "../helix/keys";
import {
  COLUMNS,
  charFor,
  type KeyDef,
  keyFor,
  keyId,
  LAYOUT,
  labelFor,
  ModifierState,
  movesCursor,
  REPEAT_DELAY,
  REPEAT_INTERVAL,
  repeats,
  widthOf,
} from "../keyboard";

interface Props {
  onKey: (key: Key) => void;
  onLower: () => void;
  /** Takes the element beneath the keys, where the editor's status line shows. */
  statusHost: (el: HTMLElement | null) => void;
}

/** The character a key under a finger types, shown above it, where the finger doesn't hide it. */
interface Preview {
  pointer: number;
  text: string;
  /** The middle of the key's top edge, within the keyboard. */
  x: number;
  y: number;
}

/**
 * The width of `n` columns, gaps between them included, as a phone's keyboard sizes its keys: so
 * a key of one and a half columns ends where the next row's keys do, half a column on.
 */
function columns(n: number): { flex: string } {
  return { flex: `0 0 calc((100% + var(--key-gap)) * ${n / COLUMNS} - var(--key-gap))` };
}

/**
 * Workshop's own keyboard, in place of the phone's, for Helix's keybindings. Keys are pressed as
 * a finger comes down, and repeat while held. Pressing keeps the focus where it is.
 */
export function Keyboard({ onKey, onLower, statusHost }: Props) {
  const modifiers = useRef(new ModifierState());
  const [mods, setMods] = useState(modifiers.current.current);
  const [down, setDown] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const root = useRef<HTMLElement>(null);
  // What lifting each finger that's down does.
  const releases = useRef(new Map<number, () => void>());
  const latestOnKey = useRef(onKey);
  latestOnKey.current = onKey;

  // Nothing carries on repeating once the keyboard's gone.
  useEffect(() => {
    const held = releases.current;
    return () => {
      for (const release of [...held.values()]) release();
    };
  }, []);

  const showModifiers = () => setMods(modifiers.current.current);
  const setKeyDown = (id: string, isDown: boolean) =>
    setDown((keys) => {
      const next = new Set(keys);
      if (isDown) next.add(id);
      else next.delete(id);
      return next;
    });

  const press = (def: KeyDef, event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Keeps the focus, and with it Helix's cursor, where it is.
    event.preventDefault();
    const el = event.currentTarget as HTMLElement;
    el.setPointerCapture(event.pointerId);
    releases.current.get(event.pointerId)?.();
    const id = keyId(def);
    setKeyDown(id, true);
    let stop = () => {};
    if (def.kind === "modifier") {
      modifiers.current.press(def.modifier);
      stop = () => modifiers.current.release(def.modifier);
    } else if (repeats(def)) {
      const used = modifiers.current.use();
      const key = keyFor(def, used);
      latestOnKey.current(key);
      let interval: number | undefined;
      const delay = window.setTimeout(() => {
        interval = window.setInterval(() => latestOnKey.current(key), REPEAT_INTERVAL);
      }, REPEAT_DELAY);
      stop = () => {
        window.clearTimeout(delay);
        window.clearInterval(interval);
      };
      const outer = root.current?.getBoundingClientRect();
      if (def.kind === "char" && def.label === undefined && outer) {
        const box = el.getBoundingClientRect();
        setPreview({
          pointer: event.pointerId,
          text: charFor(def.char, used.shift),
          x: box.left - outer.left + box.width / 2,
          y: box.top - outer.top,
        });
      }
    }
    showModifiers();
    releases.current.set(event.pointerId, () => {
      releases.current.delete(event.pointerId);
      stop();
      setKeyDown(id, false);
      showModifiers();
      setPreview((shown) => (shown?.pointer === event.pointerId ? null : shown));
    });
  };

  const release = (event: PointerEvent) => releases.current.get(event.pointerId)?.();

  return (
    <section ref={root} class="keyboard" aria-label="Keyboard">
      {LAYOUT.map((row, r) => (
        <div class={`keyboard-row keyboard-row-${row.size}`} key={r}>
          {row.inset ? <div class="key-spacer" style={columns(row.inset)} /> : null}
          {row.keys.map((def) => {
            const id = keyId(def);
            const on = def.kind === "modifier" && mods[def.modifier];
            return (
              <button
                type="button"
                key={id}
                class={`key key-${def.kind}${[...labelFor(def, false)].length > 1 ? " key-word" : ""}${movesCursor(def) ? " key-move" : ""}${on ? " on" : ""}${down.has(id) ? " down" : ""}`}
                style={columns(widthOf(def))}
                tabIndex={-1}
                aria-label={def.name}
                aria-pressed={def.kind === "modifier" ? on : undefined}
                onPointerDown={(e) => press(def, e)}
                onPointerUp={release}
                onPointerCancel={release}
                onLostPointerCapture={release}
                // A long press is a held key, not a menu.
                onContextMenu={(e) => e.preventDefault()}
              >
                {labelFor(def, mods.shift)}
              </button>
            );
          })}
          {row.inset ? <div class="key-spacer" style={columns(row.inset)} /> : null}
        </div>
      ))}
      <div class="keyboard-footer">
        <div class="keyboard-status" ref={statusHost} />
        <button
          type="button"
          class="key key-lower"
          tabIndex={-1}
          aria-label="Hide keyboard"
          // On a click, once the finger's lifted, so the controls coming back under it don't
          // take the press too. Safari only clicks if the press wasn't prevented, so just the
          // focus is kept.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onLower}
          onContextMenu={(e) => e.preventDefault()}
        >
          ▾
        </button>
      </div>
      {preview ? (
        <div
          class="key-preview"
          aria-hidden="true"
          style={{ left: `${preview.x}px`, top: `${preview.y}px` }}
        >
          {preview.text}
        </div>
      ) : null}
    </section>
  );
}
