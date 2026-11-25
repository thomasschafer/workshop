import type { JSX, RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { CodeEditor } from "../editor";
import type { Key } from "../helix/keys";
import type { KeyOffsetsState } from "../hooks/useKeyOffsets";
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
  /** The pointer, which a lift of the same finger names. */
  readonly pointer: number;
  /** When it came down, in the event's milliseconds. */
  readonly time: number;
  /** The size of the finger's contact, in pixels, and its pressure, as the browser reports. */
  readonly contact: { readonly width: number; readonly height: number; readonly pressure: number };
}

/** A finger lifting off the keyboard, after a touch that pressed a key. */
export interface KeyLift {
  readonly pointer: number;
  readonly point: Point;
  readonly time: number;
}

interface Props {
  onKey: (key: Key) => void;
  /** Lowers the keyboard, or null where it stays up. */
  onLower: (() => void) | null;
  /** How far from the middle of each key its user touches it. */
  offsets: KeyOffsets;
  /** Called with each touch that presses a key, before the key is. */
  onTouch?: (touch: KeyTouch) => void;
  /** Called with each finger that lifts after pressing a key. */
  onLift?: (lift: KeyLift) => void;
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

/** Whether a modifier's on, and whether it's locked on, for a key that draws as much itself. */
type ModifierShown = "off" | "on" | "locked";

/**
 * Keys drawn as Gboard draws them, rather than with their labels: shift drawn whether it's on, as
 * Gboard's is, and the others the same whatever the modifiers. Each is sized in the units of a
 * 411px-wide screen's pixels, as the keyboard is, from a Pixel's at 960 device pixels wide.
 */
const ICONS: ReadonlyMap<string, (shown: ModifierShown) => JSX.Element> = new Map([
  ["Shift", (shown: ModifierShown) => <ShiftIcon shown={shown} />],
  [
    "Backspace",
    () => (
      <svg
        class="key-icon"
        viewBox="0 0 58 48"
        style={iconSize(24.8, 20.5)}
        aria-hidden="true"
        key="Backspace"
      >
        <g
          fill="none"
          stroke="currentColor"
          stroke-width="4.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M2.5 24 L17 2.25 H52 a3.5 3.5 0 0 1 3.5 3.5 V42.25 a3.5 3.5 0 0 1 -3.5 3.5 H17 Z" />
          <path d="M26.5 16 L42 32 M42 16 L26.5 32" />
        </g>
      </svg>
    ),
  ],
  [
    "Enter",
    () => (
      <svg
        class="key-icon"
        viewBox="0 0 24 24"
        style={iconSize(26, 26)}
        aria-hidden="true"
        key="Enter"
      >
        <path d="M19 7v4H5.83l3.58-3.59L8 6l-6 6 6 6 1.41-1.41L5.83 13H21V7z" />
      </svg>
    ),
  ],
]);

/** Gboard's shift: an outline while it's off, filled while it's on, and underlined when locked. */
function ShiftIcon({ shown }: { shown: ModifierShown }) {
  return (
    <svg class="key-icon" viewBox="0 0 52 58" style={iconSize(22.26, 24.83)} aria-hidden="true">
      {shown === "off" ? (
        <polygon
          points="26,7 48.5,31.5 38,31.5 38,50 14,50 14,31.5 3.5,31.5"
          fill="none"
          stroke="currentColor"
          stroke-width="5"
          stroke-linejoin="round"
        />
      ) : (
        <polygon
          points={
            shown === "on"
              ? "26,8 49,31 37.5,31 37.5,50 14.5,50 14.5,31 3,31"
              : "26,4.5 49,28.5 37.5,28.5 37.5,44.75 14.5,44.75 14.5,28.5 3,28.5"
          }
          stroke="currentColor"
          stroke-width="2"
          stroke-linejoin="round"
        />
      )}
      {shown === "locked" ? <rect x="13" y="52.5" width="26" height="5.25" rx="2.6" /> : null}
    </svg>
  );
}

function iconSize(width: number, height: number): { width: string; height: string } {
  return { width: `calc(${width} * var(--u))`, height: `calc(${height} * var(--u))` };
}

const DEFS = new Map(LAYOUT.flatMap((row) => row.keys).map((def) => [keyId(def), def]));
for (const id of ICONS.keys()) {
  if (!DEFS.has(id)) throw new Error(`the keyboard has an icon for ${id}, which isn't a key`);
}

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
export function Keyboard({
  onKey,
  onLower,
  offsets,
  onTouch,
  onLift,
  showOffsets,
  statusHost,
}: Props) {
  const modifiers = useRef(new ModifierState());
  const [mods, setMods] = useState(modifiers.current.current);
  const [locks, setLocks] = useState(modifiers.current.locks);
  const [down, setDown] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const root = useRef<HTMLElement>(null);
  // What lifting each finger that's down does.
  const releases = useRef(new Map<number, () => void>());
  const latestOnKey = useRef(onKey);
  latestOnKey.current = onKey;
  const latest = useRef({ offsets, onTouch, onLift });
  latest.current = { offsets, onTouch, onLift };

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

  const showModifiers = () => {
    setMods(modifiers.current.current);
    setLocks(modifiers.current.locks);
  };
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
    latest.current.onTouch?.({
      box,
      point,
      boxes,
      column,
      finger: event.pointerType === "touch",
      pointer: event.pointerId,
      time: event.timeStamp,
      contact: { width: event.width, height: event.height, pressure: event.pressure },
    });
    keyboard.setPointerCapture(event.pointerId);
    releases.current.get(event.pointerId)?.();
    const id = keyId(def);
    setKeyDown(id, true);
    let stop = () => {};
    if (def.kind === "modifier") {
      modifiers.current.press(def.modifier, event.timeStamp);
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
  const lift = (event: PointerEvent) => {
    if (releases.current.has(event.pointerId)) {
      latest.current.onLift?.({
        pointer: event.pointerId,
        point: { x: event.clientX, y: event.clientY },
        time: event.timeStamp,
      });
    }
    release(event);
  };

  return (
    <section
      ref={root}
      class="keyboard"
      aria-label="Keyboard"
      onPointerDown={press}
      onPointerUp={lift}
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
            const locked = def.kind === "modifier" && locks[def.modifier];
            const icon = ICONS.get(id);
            return (
              <button
                type="button"
                key={id}
                class={`key key-${def.kind}${[...labelFor(def, false)].length > 1 ? " key-word" : ""}${movesCursor(def) ? " key-move" : ""}${icon ? " key-drawn" : ""}${on ? " on" : ""}${locked ? " locked" : ""}${down.has(id) ? " down" : ""}`}
                style={columns(widthOf(def))}
                tabIndex={-1}
                aria-label={def.name}
                aria-pressed={def.kind === "modifier" ? on : undefined}
                data-key={id}
              >
                {icon ? icon(locked ? "locked" : on ? "on" : "off") : labelFor(def, mods.shift)}
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
            class="keyboard-lower"
            tabIndex={-1}
            aria-label="Hide keyboard"
            // On a click, once the finger's lifted, so the controls coming back under it don't
            // take the press too. Safari only clicks if the press wasn't prevented, so just the
            // focus is kept.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onLower}
            onContextMenu={(e) => e.preventDefault()}
          >
            <svg class="keyboard-lower-icon" viewBox="0 0 23 14" aria-hidden="true">
              <polyline
                points="1.75,1.75 11.5,11.5 21.25,1.75"
                fill="none"
                stroke="currentColor"
                stroke-width="3.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
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

/** Workshop's own keyboard, typing into the code. */
export function CodeKeyboard({
  editor,
  keyOffsets,
  onLower,
  statusHost,
}: {
  editor: RefObject<CodeEditor | null>;
  keyOffsets: KeyOffsetsState;
  onLower: () => void;
  statusHost: (el: HTMLElement | null) => void;
}) {
  // The code gets shorter as the keyboard comes up, which can leave the cursor below it.
  useEffect(() => {
    editor.current?.revealCursor();
  }, []);
  return (
    <Keyboard
      onKey={(key) => editor.current?.pressKey(key)}
      onLower={onLower}
      offsets={keyOffsets.offsets}
      onTouch={keyOffsets.onTouch}
      statusHost={statusHost}
    />
  );
}

/**
 * The button in the thumb-zone controls that brings the keyboard up for the code, or lowers the
 * device's own. Workshop's own keyboard takes the controls' place, and has its own way down.
 */
export function KeyboardToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      class={`round ${shown ? "selected" : ""}`}
      aria-label={shown ? "Hide keyboard" : "Type"}
      onClick={onToggle}
    >
      ⌨
    </button>
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
