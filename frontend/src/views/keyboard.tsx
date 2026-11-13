import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Key } from "../helix/keys";
import {
  COLUMNS,
  charFor,
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
import { type KeyBox, type KeyOffsets, nearestKey, type Point } from "../touchModel";

/** A touch that pressed a key, with where every key was drawn at the time. */
export interface KeyTouch {
  readonly box: KeyBox;
  readonly point: Point;
  readonly boxes: readonly KeyBox[];
  /** A column's width, in pixels: a letter key's, with its gap. */
  readonly column: number;
  /** Whether a finger made it, rather than a mouse or pen. */
  readonly finger: boolean;
}

interface Props {
  onKey: (key: Key) => void;
  /** Lowers the keyboard, or null where it stays up. */
  onLower: (() => void) | null;
  /** How far from the middle of each key its user touches it. */
  offsets: KeyOffsets;
  /** Called with each touch that presses a key, before the key is. */
  onTouch?: (touch: KeyTouch) => void;
  /** Marks on each key where its user touches it. */
  showOffsets?: boolean;
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

const DEFS = new Map(LAYOUT.flatMap((row) => row.keys).map((def) => [keyId(def), def]));

/** Where the keys are drawn now, measured at each touch, as the keyboard moves with the page. */
function measureKeys(root: HTMLElement): {
  boxes: KeyBox[];
  elements: Map<string, HTMLElement>;
  column: number;
} {
  const elements = new Map<string, HTMLElement>();
  const boxes: KeyBox[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-key]")) {
    const id = el.dataset.key;
    if (id === undefined) continue;
    const { left, top, right, bottom } = el.getBoundingClientRect();
    elements.set(id, el);
    boxes.push({ id, left, top, right, bottom });
  }
  const q = boxes.find((box) => box.id === "q");
  const w = boxes.find((box) => box.id === "w");
  if (q === undefined || w === undefined) throw new Error("the keyboard has no q and w keys");
  return { boxes, elements, column: w.left - q.left };
}

/**
 * Workshop's own keyboard, in place of the phone's, for Helix's keybindings. Keys are pressed as
 * a finger comes down, and repeat while held. A touch anywhere among the keys presses the nearest
 * one, so the gaps between them press keys too. Pressing keeps the focus where it is.
 */
export function Keyboard({ onKey, onLower, offsets, onTouch, showOffsets, statusHost }: Props) {
  const modifiers = useRef(new ModifierState());
  const [mods, setMods] = useState(modifiers.current.current);
  const [down, setDown] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const root = useRef<HTMLElement>(null);
  // What lifting each finger that's down does.
  const releases = useRef(new Map<number, () => void>());
  const latestOnKey = useRef(onKey);
  latestOnKey.current = onKey;
  const latest = useRef({ offsets, onTouch });
  latest.current = { offsets, onTouch };

  // The marks are placed in columns, whose width the keyboard's own width decides.
  useLayoutEffect(() => {
    const keyboard = root.current;
    if (!showOffsets || keyboard === null) return;
    const place = () => keyboard.style.setProperty("--column", `${measureKeys(keyboard).column}px`);
    place();
    const observer = new ResizeObserver(place);
    observer.observe(keyboard);
    return () => observer.disconnect();
  }, [showOffsets]);

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

  const press = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const keyboard = root.current;
    if (keyboard === null) return;
    // The footer's own button, and the status line, aren't keys.
    if ((event.target as Element).closest(".keyboard-footer")) return;
    // Keeps the focus, and with it Helix's cursor, where it is.
    event.preventDefault();
    const { boxes, elements, column } = measureKeys(keyboard);
    const point = { x: event.clientX, y: event.clientY };
    const box = nearestKey(boxes, point, latest.current.offsets, column);
    const def = box ? DEFS.get(box.id) : undefined;
    const el = box ? elements.get(box.id) : undefined;
    if (!box || !def || !el) throw new Error("a touch on the keyboard found no key to press");
    latest.current.onTouch?.({ box, point, boxes, column, finger: event.pointerType === "touch" });
    keyboard.setPointerCapture(event.pointerId);
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
    <section
      ref={root}
      class="keyboard"
      aria-label="Keyboard"
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      // A long press is a held key, not a menu.
      onContextMenu={(e) => e.preventDefault()}
    >
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
                data-key={id}
              >
                {labelFor(def, mods.shift)}
                {showOffsets ? <OffsetMark offset={offsets[id]} /> : null}
              </button>
            );
          })}
          {row.inset ? <div class="key-spacer" style={columns(row.inset)} /> : null}
        </div>
      ))}
      <div class="keyboard-footer">
        <div class="keyboard-status" ref={statusHost} />
        {onLower ? (
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
        ) : null}
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

/** A dot on a key where its user touches it, from the key's middle. */
function OffsetMark({ offset }: { offset: Point | undefined }) {
  const { x, y } = offset ?? { x: 0, y: 0 };
  return (
    <span
      class="key-offset"
      aria-hidden="true"
      style={{
        left: `calc(50% + ${x} * var(--column, 0px))`,
        top: `calc(50% + ${y} * var(--column, 0px))`,
      }}
    />
  );
}
