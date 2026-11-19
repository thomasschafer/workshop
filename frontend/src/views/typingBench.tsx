import { useRef, useState } from "preact/hooks";
import { api } from "../api";
import { errorMessage } from "../errors";
import { KEY, type Key, keyChar } from "../helix/keys";
import { useCloseOnBack } from "../hooks/useCloseOnBack";
import type { KeyOffsets } from "../touchModel";
import {
  type RecordedKeyboard,
  type RecordedPress,
  score,
  TYPING_PHRASES,
  type TypedPhrase,
  type TypingKeyboard,
} from "../typingBench";
import { newSession } from "./bench";
import { Keyboard, type KeyLift, type KeyTouch } from "./keyboard";

const KEYBOARDS: { id: TypingKeyboard; label: string }[] = [
  { id: "workshop", label: "Workshop's keyboard" },
  { id: "phone-corrections-on", label: "The phone's keyboard, with its corrections on" },
  { id: "phone-corrections-off", label: "The phone's keyboard, with its corrections off" },
];

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

/** Where a phrase being typed has got to. */
interface Typing {
  text: string;
  /** When its first character was typed, in the events' milliseconds. */
  started: number | null;
  last: number | null;
  presses: RecordedPress[];
  geometry: Pick<RecordedKeyboard, "column" | "boxes"> | null;
}

const NOT_STARTED: Typing = { text: "", started: null, last: null, presses: [], geometry: null };

/**
 * Types the same phrases on Workshop's own keyboard or the phone's, to compare how accurately
 * each is typed on. Each phrase is saved on the server as it's done, with every touch on
 * Workshop's keyboard, where the keys were and where each was taken to be touched.
 */
export function TypingBench({ offsets, onClose }: { offsets: KeyOffsets; onClose: () => void }) {
  useCloseOnBack(onClose);
  const [keyboard, setKeyboard] = useState<TypingKeyboard | null>(null);
  const [session, setSession] = useState(newSession);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState<TypedPhrase[]>([]);
  const [typing, setTyping] = useState<Typing>(NOT_STARTED);
  const [error, setError] = useState<string | null>(null);
  // Touches and keys arrive faster than renders, so they're gathered here as well as shown.
  const current = useRef<Typing>(NOT_STARTED);
  const update = (next: Typing) => {
    current.current = next;
    setTyping(next);
  };

  const phrase = TYPING_PHRASES[index];

  const next = () => {
    if (phrase === undefined || keyboard === null) return;
    const { text, started, last, presses, geometry } = current.current;
    const typed: TypedPhrase = {
      kind: phrase.kind,
      target: phrase.text,
      typed: text,
      ms: started !== null && last !== null ? last - started : 0,
    };
    const recorded: RecordedKeyboard | null =
      keyboard === "workshop" && geometry ? { ...geometry, offsets, presses } : null;
    api
      .benchResult({
        session,
        bench: "typing",
        keyboard,
        phrase: index,
        ...typed,
        screen: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
        userAgent: navigator.userAgent,
        workshop: recorded,
      })
      .catch((e: unknown) => setError(`Couldn't save phrase ${index + 1}: ${errorMessage(e)}`));
    setDone([...done, typed]);
    setIndex(index + 1);
    update(NOT_STARTED);
  };

  /** Keeps what's typed, from either keyboard, timing it from its first character. */
  const typed = (text: string, time: number) => {
    const now = current.current;
    update({ ...now, text, started: now.started ?? time, last: time });
  };

  const onTouch = (touch: KeyTouch) => {
    const now = current.current;
    update({
      ...now,
      geometry: now.geometry ?? { column: touch.column, boxes: touch.boxes },
      presses: [
        ...now.presses,
        {
          key: touch.box.id,
          typed: [],
          down: { ...touch.point, t: touch.time },
          up: null,
          ...touch.contact,
          pointer: touch.pointer,
        },
      ],
    });
  };

  const onLift = (lift: KeyLift) => {
    const presses = current.current.presses;
    const press = presses.findLast((p) => p.pointer === lift.pointer && p.up === null);
    if (press) press.up = { ...lift.point, t: lift.time };
  };

  const onKey = (key: Key) => {
    const now = current.current;
    // The press that typed it, which came just before.
    now.presses.at(-1)?.typed.push(key);
    const time = performance.now();
    if (key === KEY.ret) {
      next();
    } else if (key === KEY.backspace) {
      typed([...now.text].slice(0, -1).join(""), time);
    } else {
      const char = keyChar(key);
      if (char !== null) typed(now.text + char, time);
    }
  };

  const restart = () => {
    setKeyboard(null);
    setSession(newSession());
    setIndex(0);
    setDone([]);
    update(NOT_STARTED);
    setError(null);
  };

  return (
    <div class="calibrate" role="dialog" aria-modal="true" aria-label="Compare keyboards">
      <div class="sheet-header">
        <h1>Compare keyboards</h1>
        <button type="button" class="icon-button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div class="calibrate-body">
        {error ? <p class="error-text small">{error}</p> : null}
        {keyboard === null ? (
          <>
            <p>
              Type {TYPING_PHRASES.length} short phrases, prose and then code, on one keyboard, at
              your usual speed, without correcting mistakes. Then do the same on another, to compare
              them. Each phrase is saved on the server as you finish it.
            </p>
            <p class="muted small">
              For the phone's keyboard, turn its corrections and suggestions on or off in its
              settings first, then choose which you did.
            </p>
            {KEYBOARDS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                class={`pill wide${id === "workshop" ? " primary" : ""}`}
                onClick={() => setKeyboard(id)}
              >
                {label}
              </button>
            ))}
          </>
        ) : phrase === undefined ? (
          <Results keyboard={keyboard} done={done} onAgain={restart} />
        ) : (
          <>
            <p class="muted small">
              Phrase {index + 1} of {TYPING_PHRASES.length}, {phrase.kind}.{" "}
              {keyboard === "workshop" ? "Enter goes on to the next." : null}
            </p>
            <p class="calibrate-phrase">{phrase.text}</p>
            {keyboard === "workshop" ? (
              <p class="calibrate-phrase typing-bench-typed">
                {typing.text}
                <span class="typing-bench-cursor" />
              </p>
            ) : (
              <textarea
                key={index}
                class="typing-bench-field"
                aria-label="Typed"
                rows={2}
                autocapitalize="off"
                value={typing.text}
                onInput={(e) =>
                  typed((e.target as HTMLTextAreaElement).value.replace(/\n/g, ""), e.timeStamp)
                }
                // Enter goes on, rather than starting a line.
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    next();
                  }
                }}
                ref={(el) => el?.focus({ preventScroll: true })}
              />
            )}
            <button type="button" class="pill wide" onClick={next}>
              Next phrase
            </button>
          </>
        )}
      </div>
      {keyboard === "workshop" && phrase !== undefined ? (
        <Keyboard
          onKey={onKey}
          onLower={null}
          offsets={offsets}
          onTouch={onTouch}
          onLift={onLift}
          statusHost={() => {}}
        />
      ) : null}
    </div>
  );
}

function Results({
  keyboard,
  done,
  onAgain,
}: {
  keyboard: TypingKeyboard;
  done: readonly TypedPhrase[];
  onAgain: () => void;
}) {
  const label = KEYBOARDS.find((k) => k.id === keyboard)?.label ?? keyboard;
  const rows = (["prose", "code"] as const).map((kind) => ({
    kind,
    score: score(done.filter((p) => p.kind === kind)),
  }));
  return (
    <>
      <p>Done. {label}:</p>
      <table class="bench-results">
        <tbody>
          {rows.map(({ kind, score }) =>
            score ? (
              <tr key={kind}>
                <th>{kind === "prose" ? "Prose" : "Code"}</th>
                <td>{percent(score.errorRate)} of characters wrong</td>
                <td>{Math.round(score.perMinute)} a minute</td>
              </tr>
            ) : null,
          )}
        </tbody>
      </table>
      <button type="button" class="pill primary wide" onClick={onAgain}>
        Another keyboard
      </button>
    </>
  );
}
