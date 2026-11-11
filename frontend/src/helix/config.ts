// Reads Helix's options and keymaps from Workshop's config, as the server passes them on.

import type { HelixConfigJson } from "../api";
import { DEFAULT_OPTIONS, type HelixOptions } from "./editor";
import { type KeymapProblem, type KeyTrieNode, keymapsWithConfig, type Mode } from "./keymap";

export interface HelixSettings {
  readonly keymaps: Record<Mode, KeyTrieNode>;
  readonly options: HelixOptions;
  /** Problems with the keymaps, whose keys are left out. */
  readonly problems: readonly KeymapProblem[];
}

export function helixSettings(config: HelixConfigJson): HelixSettings {
  const { keymaps, problems } = keymapsWithConfig(config.keys);
  const shapes = config["cursor-shape"] ?? {};
  const options: HelixOptions = {
    scrolloff: config.scrolloff ?? DEFAULT_OPTIONS.scrolloff,
    smartCase: config.search?.["smart-case"] ?? DEFAULT_OPTIONS.smartCase,
    wrapAround: config.search?.["wrap-around"] ?? DEFAULT_OPTIONS.wrapAround,
    autoPairs: config["auto-pairs"] ?? DEFAULT_OPTIONS.autoPairs,
    smartTab: config["smart-tab"]?.enable ?? DEFAULT_OPTIONS.smartTab,
    lineNumbers: config["line-number"] ?? DEFAULT_OPTIONS.lineNumbers,
    colorModes: config["color-modes"] ?? DEFAULT_OPTIONS.colorModes,
    cursorShape: {
      normal: shapes.normal ?? DEFAULT_OPTIONS.cursorShape.normal,
      insert: shapes.insert ?? DEFAULT_OPTIONS.cursorShape.insert,
      select: shapes.select ?? DEFAULT_OPTIONS.cursorShape.select,
    },
    jumpLabelAlphabet: config["jump-label-alphabet"] ?? DEFAULT_OPTIONS.jumpLabelAlphabet,
  };
  return { keymaps, options, problems };
}

/** Problems with the keymaps, as a message to show. */
export function describeProblems(problems: readonly KeymapProblem[]): string | null {
  if (problems.length === 0) return null;
  const list = problems.map((p) => `${p.path}: ${p.message}`).join("; ");
  return `Some Helix keys in the config were left out: ${list}`;
}
