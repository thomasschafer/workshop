import { useRef, useState } from "preact/hooks";
import { useCloseOnBack } from "../hooks/useCloseOnBack";
import {
  centreOf,
  type KeyBox,
  type KeyOffsets,
  type MeantTouch,
  type Measurement,
  measure,
  NO_OFFSETS,
} from "../touchModel";
import { Keyboard, type KeyTouch } from "./keyboard";

/**
 * What's typed to measure touches: every letter several times over, and the keys Helix leans on.
 * Lower case only, so no touch is spent on shift.
 */
const PHRASES = [
  "the quick brown fox jumps over the lazy dog",
  "pack my box with five dozen liquor jugs",
  "how vexingly quick daft zebras jump",
  "sphinx of black quartz judge my vow",
  "hjkl wb ge xd yp zz gg",
];

/** A touch further than this from the key it should be on, in columns, was a slip of the hand. */
const STRAY = 1.5;

/** A distance in columns, in whole pixels, as words: "3px right", "2px up". */
function describeOffset(x: number, y: number, column: number): string {
  const px = (n: number) => Math.round(Math.abs(n) * column);
  const parts: string[] = [];
  if (px(x) > 0) parts.push(`${px(x)}px ${x > 0 ? "right of" : "left of"}`);
  if (px(y) > 0) parts.push(`${px(y)}px ${y > 0 ? "below" : "above"}`);
  return parts.length > 0 ? `${parts.join(" and ")} the middle of a key` : "the middle of a key";
}

/**
 * Measures where this device's user touches the keys of Workshop's own keyboard, by having them
 * type phrases on it, where it sits in the app. Every touch counts for the key the phrase wants
 * next, whichever key it was nearest, which shows how far off each key is touched.
 */
export function Calibrate({
  onUse,
  onClose,
}: {
  onUse: (offsets: KeyOffsets) => void;
  onClose: () => void;
}) {
  useCloseOnBack(onClose);
  const [phrase, setPhrase] = useState(0);
  const [typed, setTyped] = useState(0);
  const [result, setResult] = useState<{ measurement: Measurement; column: number } | null>(null);
  const touches = useRef<MeantTouch[]>([]);
  const geometry = useRef<{ boxes: readonly KeyBox[]; column: number } | null>(null);

  const text = PHRASES[phrase] ?? "";

  const onTouch = (touch: KeyTouch) => {
    if (result !== null) return;
    const char = text[typed];
    if (char === undefined) return;
    // A character's key is known by the character.
    const id = char;
    const meant = touch.boxes.find((box) => box.id === id);
    if (meant === undefined) throw new Error(`the keyboard has no key for '${char}'`);
    const middle = centreOf(meant);
    const far = Math.hypot(touch.point.x - middle.x, touch.point.y - middle.y) / touch.column;
    if (far > STRAY) return;
    geometry.current = { boxes: touch.boxes, column: touch.column };
    touches.current.push({ id, point: touch.point });
    if (typed + 1 < text.length) {
      setTyped(typed + 1);
    } else if (phrase + 1 < PHRASES.length) {
      setPhrase(phrase + 1);
      setTyped(0);
    } else {
      const { boxes, column } = geometry.current;
      setResult({ measurement: measure(touches.current, boxes, column), column });
    }
  };

  const again = () => {
    touches.current = [];
    setResult(null);
    setPhrase(0);
    setTyped(0);
  };

  return (
    <div class="calibrate" role="dialog" aria-modal="true" aria-label="Measure your typing">
      <div class="sheet-header">
        <h1>Measure your typing</h1>
        <button type="button" class="icon-button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div class="calibrate-body">
        {result === null ? (
          <>
            <p class="muted small">
              Type this as you usually would, at your usual speed, without correcting mistakes.
              Phrase {phrase + 1} of {PHRASES.length}.
            </p>
            <p class="calibrate-phrase">
              <span class="calibrate-typed">{text.slice(0, typed)}</span>
              <span class="calibrate-next">{text[typed] === " " ? "␣" : text[typed]}</span>
              <span>{text.slice(typed + 1)}</span>
            </p>
          </>
        ) : (
          <Results
            measurement={result.measurement}
            column={result.column}
            onUse={() => {
              onUse(result.measurement.offsets);
              onClose();
            }}
            onAgain={again}
          />
        )}
      </div>
      <Keyboard
        onKey={() => {}}
        onLower={null}
        // As drawn, so what's measured is the fingers alone.
        offsets={result?.measurement.offsets ?? NO_OFFSETS}
        showOffsets={result !== null}
        onTouch={onTouch}
        statusHost={() => {}}
      />
    </div>
  );
}

function Results({
  measurement,
  column,
  onUse,
  onAgain,
}: {
  measurement: Measurement;
  column: number;
  onUse: () => void;
  onAgain: () => void;
}) {
  const { touches, offDrawnKey, nearestWrong, nearestWrongWithOffsets, average } = measurement;
  return (
    <>
      <p>
        Of {touches} touches, {offDrawnKey} missed the key they were for as it's drawn, landing
        between keys or on the one beside it.
      </p>
      <p>
        Taking the nearest key, {nearestWrong} would still press the wrong one. With each key moved
        to where you touch it, {nearestWrongWithOffsets} would.
      </p>
      <p class="muted small">
        On average you touch {describeOffset(average.x, average.y, column)}. The dots on the keys
        below show where you touch each one.
      </p>
      <button type="button" class="pill primary wide" onClick={onUse}>
        Use what was measured
      </button>
      <button type="button" class="pill wide" onClick={onAgain}>
        Measure again
      </button>
    </>
  );
}
