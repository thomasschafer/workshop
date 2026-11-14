import type { RefObject } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import type { EditorConfig } from "../api";
import type { CodeEditor, EditorOptions, HelixSetup } from "../editor";
import { helixSettings } from "../helix/config";
import type { HelixActions } from "../helix/view";
import * as preferences from "../preferences";
import { roundCodeScale } from "../zoom";
import { useKeyOffsets } from "./useKeyOffsets";
import { useMediaQuery } from "./useMediaQuery";

/** What the editor's Helix commands do with the file it's showing. */
export type FileActions = Pick<HelixActions, "write" | "reload" | "showProblems">;

/**
 * How the code editor looks and is typed into on this device, wherever it's used: its line
 * wrapping and text size, and whether it has Helix's keybindings, with Workshop's own keyboard on
 * a touch screen. Changes apply to `editor` straight away and are kept on the device.
 */
export function useEditorSettings(config: EditorConfig, editor: RefObject<CodeEditor | null>) {
  const [lineWrapping, setLineWrapping] = useState(() => preferences.lineWrapping.get());
  // Read through refs, as an editor keeps what it's given for as long as it's open.
  const lineWrappingRef = useRef(lineWrapping);
  lineWrappingRef.current = lineWrapping;
  const changeLineWrapping = (enabled: boolean) => {
    preferences.lineWrapping.set(enabled);
    setLineWrapping(enabled);
    lineWrappingRef.current = enabled;
    editor.current?.setLineWrapping(enabled);
  };
  const changeLineWrappingRef = useRef(changeLineWrapping);
  changeLineWrappingRef.current = changeLineWrapping;

  const [codeScale, setCodeScale] = useState(() => preferences.codeScale.get());
  const changeCodeScale = (scale: number) => {
    const kept = roundCodeScale(scale);
    preferences.codeScale.set(kept);
    setCodeScale(kept);
    editor.current?.setCodeScale(kept);
  };
  const changeCodeScaleRef = useRef(changeCodeScale);
  changeCodeScaleRef.current = changeCodeScale;

  const [keybindings, setKeybindings] = useState(() => preferences.keybindings.get());
  const helixOn =
    keybindings === "helix" || (keybindings === "config" && config.keybindings === "helix");
  const helixOnRef = useRef(helixOn);
  helixOnRef.current = helixOn;
  // With Helix's keybindings on a touch screen, typing is on Workshop's own keyboard: a laptop's
  // keys, rather than the phone's.
  const touchScreen = useMediaQuery("(pointer: coarse)");
  const ownKeyboard = helixOn && touchScreen;
  const keyOffsets = useKeyOffsets();
  const helix = useMemo(() => helixSettings(config.helix), [config]);

  /** Helix's keybindings for a file called `documentName`, or null if they're off. */
  const helixSetup = (documentName: string, actions: FileActions): HelixSetup | null =>
    helixOnRef.current
      ? {
          keymaps: helix.keymaps,
          options: helix.options,
          documentName,
          actions: {
            ...actions,
            lineWrapping: () => lineWrappingRef.current,
            setLineWrapping: (enabled) => changeLineWrappingRef.current(enabled),
          },
        }
      : null;

  /** Turns Helix's keybindings on or off on this device, for editors made from now on. */
  const setHelixOn = (enabled: boolean) => {
    const choice = enabled ? "helix" : "default";
    preferences.keybindings.set(choice);
    setKeybindings(choice);
    helixOnRef.current = enabled;
  };

  /** What a new editor starts with, of these settings. */
  const editorOptions = (): Pick<EditorOptions, "lineWrapping" | "codeScale" | "onCodeScale"> => ({
    lineWrapping: preferences.lineWrapping.get(),
    codeScale: preferences.codeScale.get(),
    onCodeScale: (scale) => changeCodeScaleRef.current(scale),
  });

  return {
    lineWrapping,
    changeLineWrapping,
    codeScale,
    changeCodeScale,
    helixOn,
    setHelixOn,
    helix,
    helixSetup,
    touchScreen,
    ownKeyboard,
    keyOffsets,
    editorOptions,
  };
}

export type EditorSettings = ReturnType<typeof useEditorSettings>;
