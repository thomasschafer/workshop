// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): indent guide calculation and
// rendering from helix-term's ui/document.rs.

import { type Extension, findClusterBreak, RangeSetBuilder, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  autoDetectIndentStyle,
  type IndentGuidesConfig,
  type IndentStyle,
  indentWidth,
} from "./editor";
import { charIsInlineWhitespace, Doc } from "./text";
import { helixIn } from "./view";

export interface IndentGuideSpan {
  /** Visual column of the first guide (`skipLevels * indentWidth`). */
  readonly startCol: number;
  /** Number of guides drawn on the line (always >= 1). */
  readonly count: number;
}

export interface IndentGuidesExtensionOptions {
  /** Fallback indent style when the file's indentation can't be detected and Helix isn't active. */
  readonly defaultIndent: IndentStyle;
  /** Config used when Helix keybindings aren't active (Helix reads its own live options). */
  readonly config: IndentGuidesConfig;
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

function assertNonNegativeInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Visual width of an inline whitespace character accepted by Helix's `char_is_whitespace`,
 * matching `unicode-width` / `grapheme_width` in `helix-core/src/graphemes.rs`.
 */
function inlineWhitespaceWidth(code: number): number {
  if (code === 0x3000) return 2;
  if (code === 0x180e || code === 0x200b || code === 0xfeff) return 0;
  return 1;
}

/**
 * Visual column of the first non-whitespace grapheme on `line`, or `null` if the line is empty
 * or contains only inline whitespace (matching `TextRenderer::draw_grapheme` in Helix's
 * `helix-term/src/ui/document.rs`).
 */
export function lineIndentColumn(line: string, tabWidth: number): number | null {
  assertPositiveInt("tabWidth", tabWidth);
  let col = 0;
  for (let i = 0; i < line.length; ) {
    const unit = line.charCodeAt(i);
    if (unit === 0x20) {
      col++;
      i++;
      continue;
    }
    if (unit === 0x09) {
      col += tabWidth - (col % tabWidth);
      i++;
      continue;
    }
    if (unit < 0x80) return col;
    const code = line.codePointAt(i);
    if (code === undefined) break;
    const ch = String.fromCodePoint(code);
    if (!charIsInlineWhitespace(ch)) return col;
    col += inlineWhitespaceWidth(code);
    i = findClusterBreak(line, i, true);
  }
  return null;
}

/**
 * Guide span for a line with effective indentation `indentLevel` (in visual columns), matching
 * `TextRenderer::draw_indent_guides` in Helix's `helix-term/src/ui/document.rs`. Returns `null`
 * when no guides should be drawn.
 */
export function indentGuideSpan(
  indentLevel: number,
  indentWidth: number,
  skipLevels: number,
): IndentGuideSpan | null {
  assertNonNegativeInt("indentLevel", indentLevel);
  assertPositiveInt("indentWidth", indentWidth);
  assertNonNegativeInt("skipLevels", skipLevels);
  const endIndent = Math.floor(indentLevel / indentWidth);
  if (endIndent <= skipLevels) return null;
  return {
    startCol: skipLevels * indentWidth,
    count: endIndent - skipLevels,
  };
}

/**
 * Visual columns that receive an indent guide for each line in `lines`. Blank and whitespace-only
 * lines reuse the previous non-blank line's indentation level, as Helix does.
 */
export function indentGuideColumns(
  lines: readonly string[],
  options: {
    readonly indentWidth: number;
    readonly tabWidth: number;
    readonly skipLevels?: number;
    /** Effective indent column carried in from the nearest non-blank line before `lines[0]`. */
    readonly initialIndent?: number;
  },
): number[][] {
  const { indentWidth: width, tabWidth, skipLevels = 0, initialIndent = 0 } = options;
  assertPositiveInt("indentWidth", width);
  assertPositiveInt("tabWidth", tabWidth);
  assertNonNegativeInt("skipLevels", skipLevels);
  assertNonNegativeInt("initialIndent", initialIndent);

  let lastIndent = initialIndent;
  return lines.map((line) => {
    const indent = lineIndentColumn(line, tabWidth);
    if (indent !== null) lastIndent = indent;
    const span = indentGuideSpan(lastIndent, width, skipLevels);
    if (span === null) return [];
    const cols: number[] = [];
    for (let i = 0; i < span.count; i++) {
      cols.push(span.startCol + i * width);
    }
    return cols;
  });
}

function precedingIndentColumn(doc: Text, fromLine: number, tabWidth: number): number {
  for (let n = fromLine; n >= 1; n--) {
    const indent = lineIndentColumn(doc.line(n).text, tabWidth);
    if (indent !== null) return indent;
  }
  return 0;
}

const lineDecorations = new Map<string, Decoration>();
const MAX_CACHED_DECORATIONS = 256;

function lineDecoration(startCol: number, count: number, width: number): Decoration {
  const key = `${startCol}:${count}:${width}`;
  let deco = lineDecorations.get(key);
  if (deco === undefined) {
    if (lineDecorations.size >= MAX_CACHED_DECORATIONS) lineDecorations.clear();
    // Clipping the repeating gradient just before the next step prevents a stray guide at
    // `startCol + count * width` regardless of subpixel rounding.
    deco = Decoration.line({
      class: "cm-indent-guides",
      attributes: {
        style: `--indent-guide-start:${startCol}ch;--indent-guide-width:calc(${count * width}ch - 1px);--indent-guide-step:${width}ch`,
      },
    });
    lineDecorations.set(key, deco);
  }
  return deco;
}

function buildDecorations(
  view: EditorView,
  width: number,
  tabWidth: number,
  skipLevels: number,
): DecorationSet {
  const doc = view.state.doc;
  const builder = new RangeSetBuilder<Decoration>();
  let lastLineNumber = 0;
  let lastIndent = 0;

  for (const { from, to } of view.visibleRanges) {
    const startLine = doc.lineAt(from).number;
    const endLine = doc.lineAt(to).number;
    for (let n = Math.max(startLine, lastLineNumber + 1); n <= endLine; n++) {
      const line = doc.line(n);
      const indent = lineIndentColumn(line.text, tabWidth);
      if (indent !== null) {
        lastIndent = indent;
      } else if (n === startLine && lastLineNumber < n - 1) {
        // Carry the nearest preceding non-blank line's indent into a visible range that starts on
        // a blank line, so scrolling past a block header doesn't drop its guides.
        lastIndent = precedingIndentColumn(doc, n - 1, tabWidth);
      }
      const span = indentGuideSpan(lastIndent, width, skipLevels);
      if (span !== null) {
        builder.add(line.from, line.from, lineDecoration(span.startCol, span.count, width));
      }
      lastLineNumber = n;
    }
  }

  return builder.finish();
}

interface EffectiveSettings {
  readonly render: boolean;
  readonly skipLevels: number;
  readonly indentWidth: number;
  readonly tabWidth: number;
}

class IndentGuidesPlugin implements PluginValue {
  decorations: DecorationSet;
  private detectedDoc: Text | null = null;
  private detectedIndent: IndentStyle | null = null;
  private last: EffectiveSettings;

  constructor(
    view: EditorView,
    private readonly options: IndentGuidesExtensionOptions,
  ) {
    this.last = this.resolve(view);
    this.decorations = this.last.render
      ? buildDecorations(view, this.last.indentWidth, this.last.tabWidth, this.last.skipLevels)
      : Decoration.none;
  }

  update(update: ViewUpdate): void {
    const next = this.resolve(update.view);
    const changed =
      next.render !== this.last.render ||
      next.skipLevels !== this.last.skipLevels ||
      next.indentWidth !== this.last.indentWidth ||
      next.tabWidth !== this.last.tabWidth;
    if (!changed && !update.docChanged && !update.viewportChanged) return;
    this.last = next;
    this.decorations = next.render
      ? buildDecorations(update.view, next.indentWidth, next.tabWidth, next.skipLevels)
      : Decoration.none;
  }

  private resolve(view: EditorView): EffectiveSettings {
    const helix = helixIn(view);
    if (helix !== null) {
      const { render, skipLevels } = helix.editor.options.indentGuides;
      return {
        render,
        skipLevels,
        indentWidth: helix.editor.indentWidth,
        tabWidth: helix.editor.tabWidth,
      };
    }
    const tabWidth = view.state.tabSize;
    if (this.detectedDoc !== view.state.doc) {
      this.detectedDoc = view.state.doc;
      this.detectedIndent = autoDetectIndentStyle(new Doc(view.state.doc));
    }
    const style = this.detectedIndent ?? this.options.defaultIndent;
    return {
      render: this.options.config.render,
      skipLevels: this.options.config.skipLevels,
      indentWidth: indentWidth(style, tabWidth),
      tabWidth,
    };
  }
}

const indentGuidesTheme = EditorView.baseTheme({
  ".cm-indent-guides": {
    backgroundOrigin: "content-box",
    backgroundRepeat: "no-repeat",
    // Half a column in, as Helix's guide character is drawn in the middle of its column.
    backgroundPosition: "calc(var(--indent-guide-start) + 0.5ch) 0",
    // Height `1lh` restricts guides to the first visual line so they never draw over wrapped text.
    backgroundSize: "var(--indent-guide-width) 1lh",
    backgroundImage:
      "repeating-linear-gradient(to right, var(--indent-guide) 0 1px, transparent 1px var(--indent-guide-step))",
  },
});

/** Draws Helix-style indentation guides on visible lines without altering document text. */
export function indentGuides(options: IndentGuidesExtensionOptions): Extension {
  return [
    indentGuidesTheme,
    ViewPlugin.define((view) => new IndentGuidesPlugin(view, options), {
      decorations: (v) => v.decorations,
    }),
  ];
}
