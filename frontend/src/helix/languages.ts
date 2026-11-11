// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// From Helix's languages.toml (https://github.com/helix-editor/helix): the comment tokens and
// indentation of the languages Workshop has built in, by Workshop's editor mode.

import type { BlockCommentToken } from "./comment";
import { type IndentStyle, IndentStyleKind } from "./editor";

export interface LanguageConfig {
  readonly lineComments: readonly string[];
  readonly blockComments: readonly BlockCommentToken[];
  readonly indent: IndentStyle;
  readonly tabWidth: number;
}

const SPACES = (n: number): IndentStyle => ({ kind: IndentStyleKind.Spaces, n });

export const LANGUAGES: Readonly<Record<string, LanguageConfig>> = {
  rust: {
    lineComments: ["//", "///", "//!"],
    blockComments: [
      { open: "/*", close: "*/" },
      { open: "/**", close: "*/" },
      { open: "/*!", close: "*/" },
    ],
    indent: SPACES(4),
    tabWidth: 4,
  },
  go: {
    lineComments: ["//"],
    blockComments: [{ open: "/*", close: "*/" }],
    indent: { kind: IndentStyleKind.Tabs },
    tabWidth: 4,
  },
  typescript: {
    lineComments: ["//"],
    blockComments: [{ open: "/*", close: "*/" }],
    indent: SPACES(2),
    tabWidth: 2,
  },
  python: { lineComments: ["#"], blockComments: [], indent: SPACES(4), tabWidth: 4 },
  haskell: {
    lineComments: ["--"],
    blockComments: [{ open: "{-", close: "-}" }],
    indent: SPACES(2),
    tabWidth: 2,
  },
  markdown: {
    lineComments: [],
    blockComments: [{ open: "<!--", close: "-->" }],
    indent: SPACES(2),
    tabWidth: 2,
  },
};

/** What Helix uses for a file with no language. */
export const PLAIN_TEXT: LanguageConfig = {
  lineComments: [],
  blockComments: [],
  indent: SPACES(4),
  tabWidth: 4,
};
