import type { RefObject } from "preact";
import { useCallback, useRef, useState } from "preact/hooks";
import type { CodeEditor } from "../editor";

/**
 * Whether the keyboard is wanted for the code, and bringing it up or lowering it: Workshop's own
 * keyboard, with Helix's keybindings on a touch screen, which the screen shows while it's wanted
 * and the code is showing, or else the device's own. Also where Helix's status line shows while
 * Workshop's keyboard is up, beneath its keys.
 *
 * `reveal` runs in the tap, before the editor takes the focus, to show the code if it's hidden:
 * the editor can't take the focus while hidden, and phones only open their keyboard for a focus
 * in the tap itself.
 */
export function useCodeKeyboard(editor: RefObject<CodeEditor | null>, reveal?: () => void) {
  const [wanted, setWanted] = useState(false);
  const statusHost = useRef<HTMLElement | null>(null);
  const placeStatus = useCallback((host: HTMLElement | null) => {
    statusHost.current = host;
    editor.current?.setStatusHost(host);
  }, []);
  const show = (shown: boolean) => {
    setWanted(shown);
    if (shown) reveal?.();
    editor.current?.setKeyboard(shown);
  };
  return { wanted, show, statusHost, placeStatus };
}

export type CodeKeyboardState = ReturnType<typeof useCodeKeyboard>;
