import { useCallback, useMemo, useState } from "preact/hooks";
import * as preferences from "../preferences";
import { type KeyOffsets, loadOffsets, NO_OFFSETS, saveOffsets, TouchLearner } from "../touchModel";
import type { KeyTouch } from "../views/keyboard";

/** The id of the key that deletes what was just typed, which marks it a mistake. */
const DELETE_KEY = "Backspace";

/**
 * Where this device's user touches the keys of Workshop's own keyboard, kept on the device, and
 * learnt as they type unless that's turned off.
 */
export function useKeyOffsets() {
  const [offsets, setOffsets] = useState(loadOffsets);
  const [learning, setLearningState] = useState(() => preferences.learnKeys.get());
  const learner = useMemo(() => new TouchLearner(loadOffsets(), (id) => id === DELETE_KEY), []);

  const replace = useCallback(
    (next: KeyOffsets) => {
      learner.reset(next);
      saveOffsets(next);
      setOffsets(next);
    },
    [learner],
  );

  const onTouch = useCallback(
    (touch: KeyTouch) => {
      // A mouse lands where it's aimed, which says nothing of fingers.
      if (!learning || !touch.finger) return;
      const next = learner.touched(touch.box, touch.point, touch.column);
      if (next === null) return;
      saveOffsets(next);
      setOffsets(next);
    },
    [learner, learning],
  );

  return {
    offsets,
    onTouch,
    /** Uses offsets measured by the typing test. */
    replace,
    reset: useCallback(() => replace(NO_OFFSETS), [replace]),
    learning,
    setLearning: useCallback((enabled: boolean) => {
      preferences.learnKeys.set(enabled);
      setLearningState(enabled);
    }, []),
  };
}

export type KeyOffsetsState = ReturnType<typeof useKeyOffsets>;
