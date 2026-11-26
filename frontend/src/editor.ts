import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
  redo,
  undo,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { nextDiagnostic, previousDiagnostic, setDiagnostics } from "@codemirror/lint";
import {
  findReferencesKeymap,
  hoverTooltips,
  jumpToDefinitionKeymap,
  type LSPClient,
  renameKeymap,
  serverDiagnostics,
  signatureHelp,
  type Transport,
} from "@codemirror/lsp-client";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  showDialog,
} from "@codemirror/view";
import { connection } from "./api";
import { markCursor, minimalChange, unmarkCursor } from "./diff";
import { errorMessage } from "./errors";
import {
  type Formatter,
  formatCode,
  formatWhenSettled,
  isFormatting,
  languageServerFormatter,
} from "./format";
import type { HelixOptions } from "./helix/editor";
import { isHelixTransaction } from "./helix/editor";
import type { KeyTrieNode, Mode } from "./helix/keymap";
import type { Key } from "./helix/keys";
import {
  type HelixActions,
  helixCursor,
  helixKeybindings,
  helixKeyboard,
  helixMode,
  pressHelixKey,
  relativeLineNumbers,
  revealHelixCursor,
  setHelixBottomInset,
  setHelixStatusHost,
} from "./helix/view";
import { adjustCapabilities, LanguageClient, languageServerCompletion, messageToShow } from "./lsp";
import { applyWorkspaceEdit } from "./lspEdits";
import { bundleForLanguage, isBundleCachedOnDevice } from "./onDevice/bundles";
import type { WorkerHelperFile } from "./onDevice/ghcWorker";
import { pinchToZoom } from "./pinch";
import type { OnDeviceMode } from "./preferences";
import { type Problem, problemAt, problemsIn, type Severity } from "./problems";
import { LANGUAGES, syntaxHighlighter } from "./syntax";
import { roundCodeScale } from "./zoom";

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "calc(var(--code-size) * var(--code-scale, 1))",
    // Pinching scales the code, rather than zooming the page.
    touchAction: "pan-x pan-y",
    background: "transparent",
    color: "var(--fg)",
  },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    // A touch heavier than regular, as terminals thicken their text, and with JetBrains Mono's
    // ligatures off so that code reads as typed.
    fontWeight: "450",
    fontVariantLigatures: "none",
    fontFeatureSettings: '"calt" 0',
    lineHeight: "1.55",
    overscrollBehavior: "contain",
  },
  ".cm-content": { caretColor: "var(--accent)", paddingBottom: "40vh" },
  ".cm-cursor": { borderLeft: "2px solid var(--accent)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-gutters": { background: "var(--bg)", border: "none", color: "var(--muted)" },
  ".cm-activeLine": { background: "var(--active-line)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    background: "var(--selection) !important",
  },
  ".cm-changed": { background: "var(--changed)", borderRadius: "2px", transition: "background 1s" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--error)",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--warn)",
    textUnderlineOffset: "3px",
  },
  ".cm-tooltip": {
    background: "var(--surface)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    fontFamily: "var(--mono)",
  },
  // A compiler's message can run to dozens of lines, which would otherwise cover the code, as
  // can documentation.
  ".cm-tooltip-lint, .cm-lsp-hover-tooltip, .cm-lsp-signature-tooltip": {
    maxWidth: "min(80ch, 90vw)",
    maxHeight: "40vh",
    overflow: "auto",
  },
  "@media (pointer: coarse)": {
    // A finger has no way to point without tapping, and a problem's message can be longer than a
    // phone's screen, so there it's read from the status line, and nothing comes up over the code.
    ".cm-tooltip-hover": { display: "none" },
    // Completions are picked by tapping, so each is as tall as a phone's own list items, with
    // what it says about itself, such as where it's imported from, on a line of its own rather
    // than cut short beside a long name. A little over four show at once, so it's clear there
    // are more to scroll to.
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      minWidth: "min(250px, 100vw)",
      maxWidth: "100vw",
      maxHeight: "calc(4.5 * var(--touch-target))",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      boxSizing: "border-box",
      minHeight: "var(--touch-target)",
      padding: "4px 10px",
      lineHeight: "1.3",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li + li": {
      borderTop: "1px solid var(--border)",
    },
    ".cm-completionLabel": {
      flex: "1 1 0",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
    ".cm-completionDetail": {
      flexBasis: "100%",
      // In line with the label, past the icon before it.
      marginLeft: "1.4em",
      overflow: "hidden",
      textOverflow: "ellipsis",
      fontSize: "0.85em",
      fontStyle: "normal",
      color: "var(--muted)",
    },
    ".cm-tooltip.cm-lsp-signature-tooltip": { maxHeight: "25vh" },
    ".cm-textfield, .cm-button": { minHeight: "var(--touch-target)" },
    ".cm-lsp-reference": { minHeight: "var(--touch-target)", alignContent: "center" },
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    background: "var(--selection)",
    color: "var(--fg)",
  },
  // The editor's own dialogs and lists, such as for a new name or a symbol's references, in the
  // app's colours, with text a finger can tap and an iPhone doesn't zoom in to.
  ".cm-panels": { background: "var(--surface)", color: "var(--fg)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel.cm-dialog": { padding: "8px 10px", fontSize: "14px" },
  ".cm-textfield": {
    fontSize: "16px",
    padding: "4px 8px",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    background: "var(--bg)",
    color: "var(--fg)",
  },
  ".cm-button": {
    padding: "4px 10px",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    backgroundImage: "none",
    background: "var(--bg)",
    color: "var(--fg)",
  },
  ".cm-lsp-reference-panel": { maxHeight: "30vh", fontSize: "13px" },
});

const flash = StateEffect.define<{ from: number; to: number } | null>();
const changedMark = Decoration.mark({ class: "cm-changed" });
const changedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(flash)) {
        next =
          effect.value && effect.value.to > effect.value.from
            ? Decoration.set([changedMark.range(effect.value.from, effect.value.to)])
            : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export interface Diagnostics {
  readonly errors: number;
  readonly warnings: number;
  /** Hints and notes, which aren't problems but are underlined all the same. */
  readonly others: number;
  /** The most serious problem the cursor is on, if it's on any. */
  readonly atCursor: Problem | null;
}

export const NO_DIAGNOSTICS: Diagnostics = { errors: 0, warnings: 0, others: 0, atCursor: null };

function sameDiagnostics(a: Diagnostics, b: Diagnostics): boolean {
  const [x, y] = [a.atCursor, b.atCursor];
  return (
    a.errors === b.errors &&
    a.warnings === b.warnings &&
    a.others === b.others &&
    (x === y ||
      (x !== null &&
        y !== null &&
        x.from === y.from &&
        x.to === y.to &&
        x.severity === y.severity &&
        x.message === y.message))
  );
}

/** Helix's keybindings, as configured, and what Workshop does for its commands. */
export interface HelixSetup {
  keymaps: Record<Mode, KeyTrieNode>;
  options: Partial<HelixOptions>;
  /** What Workshop does for Helix's commands, but formatting, which the editor does itself. */
  actions: Omit<HelixActions, "format">;
  /** The file's name, for messages such as `:w`'s. */
  documentName: string;
}

export interface EditorOptions {
  doc: string;
  cursor: number | null;
  mode: string;
  lineWrapping: boolean;
  /** How much the text is scaled from its usual size. */
  codeScale: number;
  /** Called with the scale the text was pinched to. */
  onCodeScale: (scale: number) => void;
  lsp: { client: LanguageClient; uri: string; languageId: string } | null;
  /** The language's own formatter, used instead of the language server's, if it has one. */
  formatter: Formatter | null;
  /** Whether to format before each run, and once Helix has been left in normal mode a moment. */
  formatAutomatically: boolean;
  /** Helix's keybindings, or null for CodeMirror's own. */
  helix: HelixSetup | null;
  onChange: (text: string) => void;
  onCursor: (pos: number) => void;
  onDiagnostics: (diagnostics: Diagnostics) => void;
  /** For code to read and move around in, but not change, such as a project's tests. */
  readOnly?: boolean;
}

/** Where the cursor was when an utterance was spoken. */
export interface Anchor {
  readonly id: number;
  /** How many times the user had moved the cursor themselves by then. */
  readonly moves: number;
}

export class CodeEditor {
  readonly view: EditorView;
  private readonly inputMode = new Compartment();
  private readonly wrapping = new Compartment();
  private readonly scale = new Compartment();
  private codeScale: number;
  private readonly stopPinching: () => void;
  private readonly inset = new Compartment();
  private readonly keys = new Compartment();
  private readonly numbers = new Compartment();
  private insetPx = 0;
  private flashTimer: number | undefined;
  /** The text most recently inserted by voice, which "that" refers to. */
  recentInsertion: string | null = null;
  /** Anchored cursor positions, kept up to date as the text changes. */
  private readonly anchors = new Map<number, number>();
  private nextAnchor = 1;
  /** How many times the user has moved the cursor themselves, by tapping or with keys. */
  private userMoves = 0;
  /** Whether the latest change was typing or moving with keys, which the view follows sideways. */
  private followSideways = false;

  private readonly options: EditorOptions;
  /** What was last said of the code's problems, so it's only said again when it changes. */
  private diagnostics = NO_DIAGNOSTICS;

  constructor(parent: HTMLElement, options: EditorOptions) {
    this.options = options;
    this.codeScale = options.codeScale;
    const language = LANGUAGES[options.mode];
    const cursor = Math.min(options.cursor ?? 0, options.doc.length);
    this.view = new EditorView({
      parent,
      doc: options.doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [
        // So screen readers say what the text box is.
        EditorView.contentAttributes.of({ "aria-label": "Code" }),
        this.numbers.of(this.lineNumbersFor(options.helix)),
        drawSelection(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(syntaxHighlighter),
        this.keys.of(this.keysFor(options.helix)),
        theme,
        this.wrapping.of(wrapping(options.lineWrapping)),
        this.scale.of(scaled(options.codeScale)),
        this.inset.of([]),
        changedField,
        options.readOnly ? EditorState.readOnly.of(true) : [],
        options.formatAutomatically ? formatWhenSettled(() => this.format()) : [],
        language ? language() : [],
        options.lsp ? [options.lsp.client.plugin(options.lsp.uri, options.lsp.languageId)] : [],
        this.inputMode.of(EditorView.contentAttributes.of({ inputmode: "none" })),
        // Keeping the cursor in view only scrolls up and down, unless the user is typing: a long
        // line otherwise leaves every line's start out of sight until they scroll back.
        EditorView.scrollHandler.of((view) => {
          if (this.followSideways) return false;
          const left = view.scrollDOM.scrollLeft;
          // After CodeMirror has scrolled, and before anything is drawn.
          queueMicrotask(() => {
            view.scrollDOM.scrollLeft = left;
          });
          return false;
        }),
        EditorView.updateListener.of((update) => {
          if (update.transactions.length > 0) {
            this.followSideways = update.transactions.some(followsSideways);
          }
          if (update.docChanged) {
            for (const [id, pos] of this.anchors) {
              this.anchors.set(id, update.changes.mapPos(pos, 1));
            }
          }
          if (update.transactions.some((tr) => tr.isUserEvent("select"))) {
            this.userMoves++;
          }
          if (update.docChanged) {
            options.onChange(update.state.doc.toString());
            const userTyped = update.transactions.some(
              (tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete"),
            );
            if (userTyped) {
              this.recentInsertion = null;
            }
          }
          if (update.selectionSet || update.docChanged) {
            options.onCursor(cursorOf(update.state));
          }
          const diagnostics = summarise(update.state);
          if (!sameDiagnostics(diagnostics, this.diagnostics)) {
            this.diagnostics = diagnostics;
            options.onDiagnostics(diagnostics);
          }
        }),
      ],
    });
    this.view.dispatch({ effects: EditorView.scrollIntoView(cursor, { y: "center" }) });
    this.stopPinching = pinchToZoom(this.view, {
      scale: () => this.codeScale,
      apply: (scale) => this.setCodeScale(scale),
      done: (scale) => options.onCodeScale(scale),
    });
  }

  /**
   * Shows the on-screen keyboard for typing, or hides it so taps only move the cursor. With
   * Helix's keybindings on a touch screen, the keyboard is Workshop's own, which the app shows,
   * so this only gives the focus to the field Helix reads other keyboards from.
   */
  setKeyboard(enabled: boolean): void {
    this.view.dispatch({
      effects: this.inputMode.reconfigure(
        EditorView.contentAttributes.of({ inputmode: enabled ? "text" : "none" }),
      ),
    });
    if (enabled) {
      const field = helixKeyboard(this.view);
      if (field) field.focus();
      else this.view.focus();
    }
  }

  /** Presses a key on Workshop's own keyboard, which only Helix's keybindings have. */
  pressKey(key: Key): void {
    pressHelixKey(this.view, key);
  }

  /** Shows Helix's status line in `host`, beneath Workshop's own keyboard, or under the code. */
  setStatusHost(host: HTMLElement | null): void {
    setHelixStatusHost(this.view, host);
  }

  /** Scrolls Helix's cursor into view, as after the editor has been made shorter. */
  revealCursor(): void {
    revealHelixCursor(this.view);
  }

  /**
   * Keeps the bottom `px` of the editor clear, for things floating over it, so the end of the
   * file can be scrolled above them and the cursor is never hidden behind them.
   */
  setBottomInset(px: number): void {
    this.insetPx = px;
    this.applyInset();
  }

  private applyInset(): void {
    const px = this.insetPx;
    setHelixBottomInset(this.view, px);
    // Helix's status line sits clear of what floats over the editor, so the code already ends
    // above it.
    const helix = helixMode(this.view.state) !== null;
    this.view.dispatch({
      effects: this.inset.reconfigure(
        helix
          ? []
          : [
              EditorView.scrollMargins.of(() => ({ bottom: px })),
              EditorView.contentAttributes.of({ style: `padding-bottom: ${px}px` }),
            ],
      ),
    });
  }

  /** Switches between Helix's keybindings and CodeMirror's own. */
  setHelix(helix: HelixSetup | null): void {
    this.view.dispatch({
      effects: [
        this.keys.reconfigure(this.keysFor(helix)),
        this.numbers.reconfigure(this.lineNumbersFor(helix)),
      ],
    });
    this.applyInset();
  }

  private keysFor(helix: HelixSetup | null): Extension {
    const lsp = this.options.lsp;
    if (helix === null) {
      return [
        history(),
        lsp ? languageServerKeys() : [],
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        // Shift-Alt-F formats, read by where the key is rather than what it types, which on a Mac
        // is a character such as Ï, that CodeMirror's keymaps don't take for a shortcut.
        EditorView.domEventHandlers({
          keydown: (event, view) => {
            const { code, shiftKey, altKey, ctrlKey, metaKey } = event;
            if (code !== "KeyF" || !shiftKey || !altKey || ctrlKey || metaKey) return false;
            event.preventDefault();
            this.format().catch((error: unknown) =>
              showDialog(view, {
                label: `Couldn't format the code: ${errorMessage(error)}`,
                class: "cm-lsp-message cm-lsp-message-error",
                top: true,
              }),
            );
            return true;
          },
        }),
      ];
    }
    return helixKeybindings({
      keymaps: helix.keymaps,
      options: helix.options,
      language: this.options.mode,
      documentName: helix.documentName,
      lsp: lsp ? { client: lsp.client, uri: lsp.uri } : null,
      actions: { ...helix.actions, format: () => this.format() },
    });
  }

  private lineNumbersFor(helix: HelixSetup | null): Extension {
    return helix?.options.lineNumbers === "relative" ? relativeLineNumbers() : lineNumbers();
  }

  /**
   * Formats the code with the language's formatter, or else the language server, changing only
   * what formatting changes. Returns whether it changed anything; throws if it can't format.
   */
  format(): Promise<boolean> {
    return formatCode(this.view, this.formatter());
  }

  /**
   * Formats the code before it's run, if formatting is automatic. Running doesn't wait long for
   * it, and goes ahead with the code as it is if it can't be formatted, such as if it doesn't
   * parse, which running will show.
   */
  async formatBeforeRun(): Promise<void> {
    if (!this.options.formatAutomatically) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooLong = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FORMAT_BEFORE_RUN_MS);
    });
    try {
      await Promise.race([this.format(), tooLong]);
    } catch (error) {
      console.info("[format]", error);
    } finally {
      clearTimeout(timer);
    }
  }

  private formatter(): Formatter {
    if (this.options.formatter !== null) return this.options.formatter;
    const lsp = this.options.lsp;
    if (lsp === null) throw new Error("there's nothing to format this language with");
    if (lsp.client.serverCapabilities === null) {
      throw new Error("the language server hasn't started yet");
    }
    const formatter = languageServerFormatter(lsp.client, this.view);
    if (formatter === null) throw new Error("the language server doesn't format code");
    return formatter;
  }

  /** Scales the text from its usual size. */
  setCodeScale(scale: number): void {
    if (scale === this.codeScale) return;
    this.codeScale = scale;
    this.view.dispatch({ effects: this.scale.reconfigure(scaled(scale)) });
  }

  setLineWrapping(enabled: boolean): void {
    this.view.dispatch({
      effects: this.wrapping.reconfigure(wrapping(enabled)),
    });
  }

  text(): string {
    return this.view.state.doc.toString();
  }

  markedText(): string {
    return markCursor(this.text(), cursorOf(this.view.state));
  }

  /**
   * Applies a document with a cursor marker as one undoable change. `inserted` is what the edit
   * added, which "that" refers to next.
   */
  applyMarked(marked: string, inserted: string): void {
    const { text, cursor } = unmarkCursor(marked);
    const change = minimalChange(this.text(), text);
    this.view.dispatch({
      changes: change ?? [],
      selection: EditorSelection.cursor(cursor),
      scrollIntoView: true,
      userEvent: "input.voice",
      // Its own undo step, never merged with typing or another edit made just before.
      annotations: isolateHistory.of("full"),
    });
    if (change) {
      const end = change.from + change.insert.length;
      this.recentInsertion = inserted.trim() || change.insert.trim() || null;
      this.flash(change.from, end);
    }
  }

  insertSnippet(body: string): void {
    // With Helix's keybindings, at the cursor rather than over the selection, as Helix pastes.
    const { from, to } =
      helixMode(this.view.state) === null
        ? this.view.state.selection.main
        : { from: cursorOf(this.view.state), to: cursorOf(this.view.state) };
    this.view.dispatch({
      changes: { from, to, insert: body },
      selection: EditorSelection.cursor(from + body.length),
      scrollIntoView: true,
      userEvent: "input.snippet",
      annotations: isolateHistory.of("full"),
    });
    this.recentInsertion = body;
    this.flash(from, from + body.length);
  }

  replaceAll(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: EditorSelection.cursor(Math.min(this.view.state.selection.main.head, text.length)),
    });
  }

  private flash(from: number, to: number): void {
    this.view.dispatch({ effects: flash.of({ from, to }) });
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(
      () => this.view.dispatch({ effects: flash.of(null) }),
      1600,
    );
  }

  undo(): void {
    undo(this.view);
  }

  redo(): void {
    redo(this.view);
  }

  gotoLine(line: number): boolean {
    const doc = this.view.state.doc;
    if (line < 1 || line > doc.lines) {
      return false;
    }
    const target = doc.line(line);
    this.view.dispatch({
      selection: EditorSelection.cursor(target.from),
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
    return true;
  }

  /** Every problem in the code, in the order they come in it. */
  problems(): Problem[] {
    return problemsIn(this.view.state);
  }

  /** Puts the cursor at the start of a problem, in the middle of the view. */
  gotoProblem(problem: Problem): void {
    const pos = Math.min(problem.from, this.view.state.doc.length);
    this.view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
      userEvent: "select",
    });
  }

  nextError(): void {
    nextDiagnostic(this.view);
  }

  previousError(): void {
    previousDiagnostic(this.view);
  }

  /**
   * Replaces `find` with `replace` as one undoable edit, highlighting the change, if the text
   * contains it. Returns whether it did.
   */
  swapText(find: string, replace: string): boolean {
    const from = this.view.state.doc.toString().indexOf(find);
    if (from === -1) return false;
    this.view.dispatch({
      changes: { from, to: from + find.length, insert: replace },
      selection: EditorSelection.cursor(from + replace.length),
      scrollIntoView: true,
      userEvent: "input.voice",
      annotations: isolateHistory.of("full"),
    });
    this.flash(from, from + replace.length);
    return true;
  }

  /** Remembers where the cursor is now, following it as the text changes. */
  anchor(): Anchor {
    const id = this.nextAnchor++;
    this.anchors.set(id, cursorOf(this.view.state));
    return { id, moves: this.userMoves };
  }

  /**
   * Puts the cursor back where it was anchored, if the user has moved it themselves since.
   * Otherwise it stays where it is, which is where any earlier edits left it, so utterances
   * spoken one after another carry on from each other. The anchor is then forgotten.
   */
  restore(anchor: Anchor): void {
    const pos = this.anchors.get(anchor.id);
    this.anchors.delete(anchor.id);
    if (pos === undefined || this.userMoves === anchor.moves) return;
    this.view.dispatch({
      selection: EditorSelection.cursor(Math.min(pos, this.view.state.doc.length)),
      scrollIntoView: true,
    });
  }

  /** Forgets an anchor that won't be used, such as for a cancelled utterance. */
  release(anchor: Anchor): void {
    this.anchors.delete(anchor.id);
  }

  /**
   * Forgets the language server's errors, such as when it restarts: a new server that finds no
   * errors says nothing, so the old ones would otherwise stay.
   */
  clearDiagnostics(): void {
    this.view.dispatch(setDiagnostics(this.view.state, []));
  }

  diagnosticsText(): string {
    return this.problems()
      .map((p) => `line ${p.line} (${p.severity}): ${p.message}`)
      .join("\n");
  }

  /** Words in the file, used to help speech recognition hear identifiers. */
  identifiers(): string[] {
    const words = new Set(this.text().match(/[A-Za-z_][A-Za-z0-9_']{2,}/g) ?? []);
    return [...words];
  }

  destroy(): void {
    window.clearTimeout(this.flashTimer);
    this.stopPinching();
    this.view.destroy();
  }
}

/**
 * What the language server does for the editor's own keybindings, beyond marking problems:
 * completions as you type, what a function takes as its arguments are typed, and keys to rename
 * (F2), go to a definition (F12), list references (Shift-F12) and format (Shift-Alt-F). With a
 * mouse, pointing at something shows its documentation.
 */
function languageServerKeys(): Extension {
  const touch = window.matchMedia("(pointer: coarse)").matches;
  return [
    // On a phone's keyboard, Enter is for new lines, unless a completion's been chosen.
    languageServerCompletion({ selectOnOpen: !touch }),
    signatureHelp(),
    // A finger has no way to point without tapping, which moves the cursor.
    touch ? [] : hoverTooltips(),
    keymap.of([...renameKeymap, ...jumpToDefinitionKeymap, ...findReferencesKeymap]),
  ];
}

/**
 * Without wrapping, lines can be scrolled a good way past their end, so there is room to tap
 * beside the end of the longest one to put the cursor there.
 */
const scrollPastLineEnd = EditorView.theme({ ".cm-content": { paddingRight: "40vw" } });

const scaleThemes = new Map<number, Extension>();

/**
 * Scales the text, and so the gutter and tooltips with it, from its usual size. As a theme, as
 * CodeMirror measures its lines again when its theme changes, but not its attributes, and would
 * otherwise leave the line numbers spaced for the old size once the whole file fits on screen.
 * One per percent, so pinching doesn't keep adding styles to the page.
 */
function scaled(scale: number): Extension {
  const rounded = roundCodeScale(scale);
  let theme = scaleThemes.get(rounded);
  if (theme === undefined) {
    theme = EditorView.theme({ "&": { "--code-scale": String(rounded) } });
    scaleThemes.set(rounded, theme);
  }
  return theme;
}

function wrapping(enabled: boolean): Extension {
  return enabled ? EditorView.lineWrapping : scrollPastLineEnd;
}

/**
 * Where the cursor is: the head of the main selection, or with Helix's keybindings, the left of
 * its block cursor, which is where typing goes.
 */
function cursorOf(state: EditorState): number {
  return helixMode(state) === null ? state.selection.main.head : helixCursor(state);
}

/** Typing, deleting and moving with keys, rather than tapping or edits made by voice. */
function followsSideways(tr: Transaction): boolean {
  return (
    isHelixTransaction(tr) ||
    tr.isUserEvent("input.type") ||
    tr.isUserEvent("input.paste") ||
    tr.isUserEvent("input.complete") ||
    tr.isUserEvent("delete") ||
    (tr.isUserEvent("select") && !tr.isUserEvent("select.pointer"))
  );
}

function summarise(state: EditorState): Diagnostics {
  const problems = problemsIn(state);
  const count = (...severities: Severity[]) =>
    problems.filter((p) => severities.includes(p.severity)).length;
  return {
    errors: count("error"),
    warnings: count("warning"),
    others: count("info", "hint"),
    atCursor: problemAt(problems, cursorOf(state)),
  };
}

/** Requests from the server that Workshop answers itself, as its language client can't. */
type ServerRequests = Readonly<Record<string, (params: unknown) => unknown>>;

class SocketTransport implements Transport {
  private readonly handlers = new Set<(value: string) => void>();

  constructor(
    private readonly socket: WebSocket,
    private readonly requests: ServerRequests,
  ) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      if (this.answer(event.data)) return;
      for (const handler of this.handlers) handler(event.data);
    });
  }

  /** Answers a request from the server that Workshop handles. Returns whether it was one. */
  private answer(data: string): boolean {
    const message = JSON.parse(data) as { id?: number | string; method?: string; params?: unknown };
    const handle = message.method === undefined ? undefined : this.requests[message.method];
    if (message.id === undefined || handle === undefined) return false;
    let reply: object;
    try {
      reply = { result: handle(message.params) ?? null };
    } catch (error) {
      console.error(error);
      reply = { error: { code: -32603, message: errorMessage(error) } };
    }
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply }));
    return true;
  }

  send(message: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(adjustCapabilities(message));
    }
  }

  subscribe(handler: (value: string) => void): void {
    this.handlers.add(handler);
  }

  unsubscribe(handler: (value: string) => void): void {
    this.handlers.delete(handler);
  }
}

class WorkerTransport implements Transport {
  private readonly handlers = new Set<(value: string) => void>();

  constructor(private readonly worker: Worker) {
    worker.addEventListener("message", this.onMessage);
  }

  private readonly onMessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data !== "string") return;
    for (const handler of this.handlers) handler(event.data);
  };

  send(message: string): void {
    this.worker.postMessage(adjustCapabilities(message));
  }

  notify(method: string, params: unknown): void {
    this.worker.postMessage(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  subscribe(handler: (value: string) => void): void {
    this.handlers.add(handler);
  }

  unsubscribe(handler: (value: string) => void): void {
    this.handlers.delete(handler);
  }

  close(): void {
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.terminate();
  }
}

export type LanguageServerStatus = "connecting" | "ready" | "reconnecting" | "unavailable";
export type LanguageServerBackend = "server" | "local";

/** Optional on-device fallback/override configuration for a LanguageServerConnection. */
export interface LocalLanguageServerOptions {
  languageId: string;
  mode: OnDeviceMode;
  onBackend: (backend: LanguageServerBackend) => void;
  createWorker?: () => Worker;
}

/** Bounded initial server-connect wait in Automatic mode before failing over to local WASM LSP. */
export const AUTOMATIC_SERVER_TIMEOUT_MS = 4500;

/** Why the language server can't be used, and how to put that right, if that's known. */
export interface LanguageServerUnavailable {
  reason: string;
  help: string | null;
}

/** How long a run waits for the code to be formatted first. */
const FORMAT_BEFORE_RUN_MS = 3000;

const MIN_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;

/**
 * How many times in a row a connection may close before the language server is ready, before
 * it's given up on: about a minute, waiting longer each time.
 */
export const MAX_CONNECTION_ATTEMPTS = 6;

/** What the relay sends, just before closing the connection, when the server can't start. */
const UNAVAILABLE = "workshop/unavailable";

function defaultLspWorkerFactory(): Worker {
  return new Worker(new URL("./onDevice/ghcLspWorker.ts", import.meta.url), { type: "module" });
}

/**
 * Keeps one language server client connected — either through Workshop's websocket relay or,
 * when opted into on-device mode (or in Automatic mode when the server can't be reached), through
 * a dedicated local WASM LSP Web Worker. Editors keep using the same client across reconnects and
 * backend switches without being recreated.
 */
export class LanguageServerConnection {
  readonly client: LanguageClient;
  private socket: WebSocket | null = null;
  private workerTransport: WorkerTransport | null = null;
  private retryDelay = MIN_RECONNECT_MS;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private failoverTimer: ReturnType<typeof setTimeout> | undefined;
  /** Connections in a row that closed before the server was ready. */
  private failures = 0;
  /** What the relay said, if it said the server can't start. */
  private refused: LanguageServerUnavailable | null = null;
  private givenUp = false;
  private closed = false;
  private backend: LanguageServerBackend = "server";
  private helpers: WorkerHelperFile[] = [];
  private readonly stopOnlineListener: () => void;

  constructor(
    rootUri: string,
    initializationOptions: unknown,
    private readonly onStatus: (status: LanguageServerStatus) => void,
    /** Called with an error the language server reports, other than one formatting reports. */
    private readonly onError: (message: string) => void,
    /** Called with why the server's been given up on, and with null when it's tried again. */
    private readonly onUnavailable: (why: LanguageServerUnavailable | null) => void,
    /** The relay's address on the server, for the language and the files it serves. */
    private readonly path = "/api/lsp",
    private readonly local?: LocalLanguageServerOptions,
  ) {
    this.client = new LanguageClient({
      rootUri,
      initializationOptions,
      timeout: 30_000,
      extensions: [serverDiagnostics()],
      // Handled here rather than shown over the code, as the client would.
      notificationHandlers: {
        "window/showMessage": (client, params) => {
          const error = messageToShow(params, isFormatting(client));
          if (error !== null) this.onError(error);
          return true;
        },
        [UNAVAILABLE]: (_client, params: { reason?: unknown; help?: unknown }) => {
          this.refused = {
            reason: typeof params.reason === "string" ? params.reason : "it couldn't start",
            help: typeof params.help === "string" ? params.help : null,
          };
          return true;
        },
      },
    });
    document.addEventListener("visibilitychange", this.onVisibility);
    this.stopOnlineListener = connection.subscribe((online) => {
      if (
        online &&
        this.backend === "server" &&
        this.socket === null &&
        this.workerTransport === null &&
        !this.closed &&
        !this.givenUp
      ) {
        this.retryDelay = MIN_RECONNECT_MS;
        clearTimeout(this.retryTimer);
        void this.start();
      }
    });
    void this.start();
  }

  private async hasLocalBundle(): Promise<boolean> {
    if (!this.local || this.local.mode === "server") return false;
    const bundle = bundleForLanguage(this.local.languageId);
    if (!bundle) return false;
    return isBundleCachedOnDevice(bundle);
  }

  private setBackend(next: LanguageServerBackend): void {
    this.backend = next;
    this.local?.onBackend(next);
  }

  private async start(): Promise<void> {
    const canUseLocal = await this.hasLocalBundle();
    if (this.closed) return;
    if (this.local?.mode === "local" && canUseLocal) {
      this.openLocal();
      return;
    }
    const effectivelyOnline =
      connection.isOnline && (typeof navigator === "undefined" || navigator.onLine !== false);
    if (this.local?.mode === "automatic" && canUseLocal && !effectivelyOnline) {
      this.openLocal();
      return;
    }
    this.openServer(canUseLocal && this.local?.mode === "automatic");
  }

  private readonly onVisibility = () => {
    if (
      document.visibilityState === "visible" &&
      this.backend === "server" &&
      this.socket === null &&
      this.workerTransport === null &&
      !this.closed &&
      !this.givenUp
    ) {
      clearTimeout(this.retryTimer);
      void this.start();
    }
  };

  private openServer(allowLocalFailover: boolean): void {
    this.closeWorker();
    this.setBackend("server");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}${this.path}`);
    this.socket = socket;
    let ready = false;
    let failedOver = false;
    this.onStatus(this.retryDelay === MIN_RECONNECT_MS ? "connecting" : "reconnecting");

    clearTimeout(this.failoverTimer);
    if (allowLocalFailover) {
      this.failoverTimer = setTimeout(() => {
        if (this.closed || ready || this.socket !== socket) return;
        failedOver = true;
        socket.close();
        this.socket = null;
        if (this.client.connected) this.client.disconnect();
        this.openLocal();
      }, AUTOMATIC_SERVER_TIMEOUT_MS);
    }

    socket.addEventListener("open", () => {
      // Until the server has initialised, the diagnostics on screen may be stale.
      this.client
        .connect(
          new SocketTransport(socket, {
            "workspace/applyEdit": (params) => applyWorkspaceEdit(this.client, params),
          }),
        )
        .initializing.then(() => {
          if (this.socket !== socket || failedOver) return;
          clearTimeout(this.failoverTimer);
          ready = true;
          // Only now, as the relay accepts the connection before it starts the server.
          this.retryDelay = MIN_RECONNECT_MS;
          this.failures = 0;
          this.client.sync();
          this.onStatus("ready");
        })
        .catch(() => {});
    });
    // A failed connection attempt also fires `close`, so retrying is handled there alone.
    socket.addEventListener("close", () => {
      clearTimeout(this.failoverTimer);
      if (failedOver) return;
      if (this.client.connected && this.backend === "server") {
        this.client.disconnect();
      }
      if (this.socket === socket) this.socket = null;
      if (this.closed) return;
      if (this.refused !== null) {
        if (allowLocalFailover) {
          this.refused = null;
          this.openLocal();
          return;
        }
        this.giveUp(this.refused);
        return;
      }
      if (!ready && allowLocalFailover) {
        this.openLocal();
        return;
      }
      const browserOffline =
        !connection.isOnline || (typeof navigator !== "undefined" && navigator.onLine === false);
      if (browserOffline && !allowLocalFailover) {
        // Don't burn retry attempts or give up permanently while offline; reconnect once back online.
        this.onStatus("reconnecting");
        return;
      }
      if (!ready) this.failures++;
      if (this.failures >= MAX_CONNECTION_ATTEMPTS) {
        this.giveUp({
          reason: "the connection to the language server kept closing before it was ready",
          help: null,
        });
        return;
      }
      if (ready && allowLocalFailover) {
        // Server dropped after being connected in Automatic mode: switch cleanly and stay sticky on local.
        this.openLocal();
        return;
      }
      this.onStatus("reconnecting");
      // Hidden pages wait for `visibilitychange` instead of retrying in the background.
      if (document.visibilityState === "visible") {
        this.retryTimer = setTimeout(() => this.openServer(allowLocalFailover), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, MAX_RECONNECT_MS);
      }
    });
  }

  private openLocal(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.failoverTimer);
    this.socket?.close();
    this.socket = null;
    this.closeWorker();
    if (this.client.connected) this.client.disconnect();

    this.setBackend("local");
    this.givenUp = false;
    this.refused = null;
    this.client.unavailable = null;
    this.onUnavailable(null);
    this.onStatus("connecting");

    const createWorker = this.local?.createWorker ?? defaultLspWorkerFactory;
    let worker: Worker;
    try {
      worker = createWorker();
    } catch (error) {
      this.giveUp({
        reason: `couldn't start the on-device language server: ${errorMessage(error)}`,
        help: null,
      });
      return;
    }

    const transport = new WorkerTransport(worker);
    this.workerTransport = transport;
    worker.addEventListener("error", (ev) => {
      if (this.workerTransport !== transport || this.closed) return;
      this.closeWorker();
      if (this.client.connected) this.client.disconnect();
      this.giveUp({
        reason: ev.message || "the on-device language server crashed",
        help: null,
      });
    });

    this.client
      .connect(transport)
      .initializing.then(() => {
        if (this.workerTransport !== transport || this.closed) return;
        if (this.helpers.length > 0) {
          transport.notify("workshop/setHelpers", { helpers: this.helpers });
        }
        this.client.sync();
        this.onStatus("ready");
      })
      .catch((error) => {
        if (this.workerTransport !== transport || this.closed) return;
        this.closeWorker();
        this.giveUp({
          reason: `couldn't initialize the on-device language server: ${errorMessage(error)}`,
          help: null,
        });
      });
  }

  private closeWorker(): void {
    if (this.workerTransport) {
      this.workerTransport.close();
      this.workerTransport = null;
    }
  }

  private giveUp(why: LanguageServerUnavailable): void {
    this.givenUp = true;
    this.client.unavailable = why.reason;
    this.onStatus("unavailable");
    this.onUnavailable(why);
  }

  /** Updates shared helper modules (such as `lib/Aoc.hs`) in the on-device LSP Worker. */
  setHelpers(helpers: WorkerHelperFile[]): void {
    this.helpers = helpers;
    this.workerTransport?.notify("workshop/setHelpers", { helpers });
  }

  /** Manual switch from sticky on-device LSP back to the server HLS (e.g. from Problems sheet). */
  reconnectServer(): void {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    clearTimeout(this.failoverTimer);
    this.givenUp = false;
    this.refused = null;
    this.failures = 0;
    this.retryDelay = MIN_RECONNECT_MS;
    this.client.unavailable = null;
    this.onUnavailable(null);
    this.closeWorker();
    if (this.client.connected) this.client.disconnect();
    void this.hasLocalBundle().then((canUseLocal) => {
      if (this.closed) return;
      this.openServer(canUseLocal && this.local?.mode === "automatic");
    });
  }

  /** Connects afresh to a server that's been given up on, such as once it's been installed. */
  retry(): void {
    if (this.closed || !this.givenUp) return;
    this.givenUp = false;
    this.refused = null;
    this.failures = 0;
    this.retryDelay = MIN_RECONNECT_MS;
    this.client.unavailable = null;
    this.onUnavailable(null);
    void this.start();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.failoverTimer);
    this.stopOnlineListener();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.socket?.close();
    this.closeWorker();
  }
}

interface HoverResult {
  contents: string | { value: string } | (string | { value: string })[];
}

/** The type or signature of the thing at `pos`, as the language server describes it. */
export async function hoverText(
  client: LSPClient,
  uri: string,
  view: EditorView,
  pos: number,
): Promise<string | null> {
  if (!client.serverCapabilities?.hoverProvider) {
    return null;
  }
  client.sync();
  const line = view.state.doc.lineAt(pos);
  const result = await client.request<unknown, HoverResult | null>("textDocument/hover", {
    textDocument: { uri },
    position: { line: line.number - 1, character: pos - line.from },
  });
  if (!result) {
    return null;
  }
  const parts = Array.isArray(result.contents) ? result.contents : [result.contents];
  const text = parts.map((p) => (typeof p === "string" ? p : p.value)).join("\n");
  const code = text.match(/```\w*\n([\s\S]*?)```/);
  const firstBlock = (code?.[1] ?? text).trim();
  return firstBlock.split("\n").find((l) => l.includes("::")) ?? firstBlock.split("\n")[0] ?? null;
}
