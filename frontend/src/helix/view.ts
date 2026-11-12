// Helix's keybindings in a CodeMirror editor: the view's side of the editor model, which turns
// key presses into Helix commands, draws Helix's cursors, and shows the mode, prompts and help.

import {
  autocompletion,
  closeCompletion,
  completionStatus,
  startCompletion,
} from "@codemirror/autocomplete";
import { redo, undo } from "@codemirror/commands";
import { getIndentation, IndentContext } from "@codemirror/language";
import { forEachDiagnostic } from "@codemirror/lint";
import {
  findReferences,
  formatDocument,
  jumpToDeclaration,
  jumpToDefinition,
  jumpToImplementation,
  jumpToTypeDefinition,
  type LSPClient,
  renameSymbol,
  serverCompletionSource,
  showSignatureHelp,
} from "@codemirror/lsp-client";
import {
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  type Range,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  type Panel,
  type PluginValue,
  showPanel,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { pasteImpl } from "./commands";
import {
  fromEditorSelection,
  type HelixDiagnostic,
  HelixEditor,
  type HelixOptions,
  type Host,
  type HostAction,
  helixSelection,
  type Info,
  insertSelectionField,
  isHelixTransaction,
  type ScrollRequest,
  toEditorSelection,
} from "./editor";
import { KeyHandler } from "./handler";
import { helixHistory } from "./history";
import type { KeyTrieNode, Mode } from "./keymap";
import { type Key, keyChar, keyFromEvent, unparseKey } from "./keys";
import { LANGUAGES, PLAIN_TEXT } from "./languages";
import { pickerMatches } from "./picker";
import { Selection } from "./selection";
import { Doc, graphemes, nextGraphemeBoundary } from "./text";

/** What Workshop does for Helix's commands that reach beyond the editor. */
export interface HelixActions {
  /** Saves the file now, for `:w`. */
  write(): Promise<void>;
  /** Picks up the file as it is on disk, for `:reload`. */
  reload(): Promise<void>;
  setLineWrapping(enabled: boolean): void;
  lineWrapping(): boolean;
}

export interface HelixConfig {
  readonly keymaps: Record<Mode, KeyTrieNode>;
  readonly options: Partial<HelixOptions>;
  /** Workshop's editor mode for the language, such as `python`. */
  readonly language: string;
  readonly documentName: string;
  readonly lsp: { readonly client: LSPClient; readonly uri: string } | null;
  readonly actions: HelixActions;
}

const modeChanged = StateEffect.define<Mode>();

/** The mode, in the state so decorations and styles can follow it. */
const modeField = StateField.define<Mode>({
  create: () => "normal",
  update: (mode, tr) => {
    for (const e of tr.effects) if (e.is(modeChanged)) return e.value;
    return mode;
  },
});

/** The Helix mode a state is in. */
export function helixMode(state: EditorState): Mode | null {
  return state.field(modeField, false) ?? null;
}

/** Where Helix's primary cursor is: the left side of its block. */
export function helixCursor(state: EditorState): number {
  return helixSelection(state).primary.cursor(new Doc(state.doc));
}

/**
 * Keeps selections made other than by Helix's commands, such as by tapping or by voice, at least a
 * character wide, as Helix keeps its selections.
 */
const keepSelectionsWide = EditorState.transactionFilter.of((tr) => {
  if (isHelixTransaction(tr) || (!tr.selection && !tr.docChanged)) return tr;
  // In insert mode, CodeMirror's selection is just the cursors.
  if (tr.startState.field(insertSelectionField, false)) return tr;
  const doc = new Doc(tr.newDoc);
  const selection = fromEditorSelection(tr.newSelection);
  const wide = selection.ensureInvariants(doc);
  if (wide.equals(selection)) return tr;
  return [tr, { selection: toEditorSelection(wide), sequential: true }];
});

// ---- Cursors ----

class EndCursor extends WidgetType {
  constructor(private readonly className: string) {
    super();
  }

  override eq(other: EndCursor): boolean {
    return other.className === this.className;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = " ";
    return span;
  }
}

class JumpLabel extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  override eq(other: JumpLabel): boolean {
    return other.label === this.label;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-helix-jump-label";
    span.textContent = this.label;
    return span;
  }
}

/**
 * The selections, drawn as marks on the text, where they show over a line's own background,
 * and with the line endings they take in, as Helix shows them. Only in view, as `%` can select a
 * whole long file.
 */
function selectionDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const doc = new Doc(state.doc);
  const selection = helixSelection(state);
  const decorations: Range<Decoration>[] = [];
  const mark = Decoration.mark({ class: "cm-helix-selection" });
  const lineEnd = Decoration.widget({ widget: new EndCursor("cm-helix-selection"), side: 1 });
  for (const range of selection.ranges) {
    if (range.empty) continue;
    const cursor = range.cursor(doc);
    for (const visible of view.visibleRanges) {
      const from = Math.max(range.from, visible.from);
      const to = Math.min(range.to, visible.to);
      if (from >= to) continue;
      decorations.push(mark.range(from, to));
      for (
        let pos = doc.str.indexOf("\n", from);
        pos !== -1 && pos < to;
        pos = doc.str.indexOf("\n", pos + 1)
      ) {
        if (pos !== cursor) decorations.push(lineEnd.range(pos));
      }
    }
  }
  return Decoration.set(decorations, true);
}

function cursorDecorations(view: EditorView, editor: HelixEditor): DecorationSet {
  const state = view.state;
  const doc = new Doc(state.doc);
  const mode = state.field(modeField);
  const shape = editor.options.cursorShape[mode];
  const builder: { from: number; to: number; deco: Decoration }[] = [];
  if (shape !== "hidden") {
    const selection = helixSelection(state);
    selection.ranges.forEach((range, i) => {
      const primary = i === selection.primaryIndex;
      const className = `cm-helix-cursor cm-helix-cursor-${shape}${primary ? " cm-helix-cursor-primary" : ""}`;
      const pos = range.cursor(doc);
      const ch = doc.char(pos);
      if (ch === undefined || ch === "\n") {
        builder.push({
          from: pos,
          to: pos,
          deco: Decoration.widget({ widget: new EndCursor(className), side: 1 }),
        });
      } else {
        builder.push({
          from: pos,
          to: nextGraphemeBoundary(doc, pos),
          deco: Decoration.mark({ class: className }),
        });
      }
    });
  }
  for (const label of editor.jumpLabels) {
    let to = label.from;
    for (let i = 0; i < 2; i++) {
      const next = nextGraphemeBoundary(doc, to);
      if (doc.slice(to, next) === "\n" || next === to) break;
      to = next;
    }
    builder.push({
      from: label.from,
      to,
      deco: Decoration.replace({ widget: new JumpLabel(label.label) }),
    });
  }
  builder.sort((a, b) => a.from - b.from || a.to - b.to);
  const set = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const { from, to, deco } of builder) {
    // Replacements can't overlap anything, so labels win over a cursor in the same place.
    if (from < last) continue;
    set.add(from, to, deco);
    if (to > from) last = to;
  }
  return set.finish();
}

// ---- Relative line numbers ----

class LineNumber extends GutterMarker {
  constructor(private readonly text: string) {
    super();
  }

  override eq(other: LineNumber): boolean {
    return other.text === this.text;
  }

  override toDOM(): Node {
    return document.createTextNode(this.text);
  }
}

/** Line numbers counting from the cursor's line, which shows its own number, as Helix shows them. */
export function relativeLineNumbers(): Extension {
  return gutter({
    class: "cm-lineNumbers",
    lineMarker: (view, line) => {
      const number = view.state.doc.lineAt(line.from).number;
      const cursorLine = view.state.doc.lineAt(helixCursor(view.state)).number;
      return new LineNumber(String(number === cursorLine ? number : Math.abs(number - cursorLine)));
    },
    lineMarkerChange: (update) => update.selectionSet || update.docChanged,
    initialSpacer: (view) => new LineNumber(String(view.state.doc.lines)),
    updateSpacer: (_spacer, update) => new LineNumber(String(update.state.doc.lines)),
  });
}

// ---- The plugin ----

const MODE_NAMES: Record<Mode, string> = { normal: "NOR", insert: "INS", select: "SEL" };

class HelixView implements PluginValue, Host {
  readonly editor: HelixEditor;
  readonly handler: KeyHandler;
  decorations: DecorationSet;
  selections: DecorationSet;
  private scrollRequest: ScrollRequest | null = null;
  private dispatching = false;
  private readonly panel: StatusPanel;
  readonly documentName: string;

  constructor(
    readonly view: EditorView,
    private readonly config: HelixConfig,
  ) {
    this.documentName = config.documentName;
    const language = LANGUAGES[config.language] ?? PLAIN_TEXT;
    this.editor = new HelixEditor(this, config.options, language.indent);
    this.handler = new KeyHandler(this.editor, config.keymaps, () => this.afterKey());
    this.editor.onChange = () => this.refresh();
    this.panel = new StatusPanel(this);
    this.decorations = cursorDecorations(view, this.editor);
    this.selections = selectionDecorations(view);
    // Capturing, so keys reach Helix before CodeMirror, which holds some back on phones.
    view.dom.addEventListener("keydown", this.onKey, true);
    view.dom.addEventListener("beforeinput", this.onBeforeInput, true);
    // A phone's keyboard coming up can cover the cursor.
    window.visualViewport?.addEventListener("resize", this.onViewportResize);
    // Start with the selection as Helix keeps it.
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.editor.setSelection(this.editor.selection);
    });
  }

  private destroyed = false;

  get state(): EditorState {
    return this.view.state;
  }

  get panelDom(): StatusPanel {
    return this.panel;
  }

  dispatch(spec: Parameters<EditorView["dispatch"]>[0]): void {
    this.dispatching = true;
    try {
      this.view.dispatch(spec);
    } finally {
      this.dispatching = false;
    }
  }

  update(update: ViewUpdate): void {
    for (const tr of update.transactions) this.editor.mapThroughChanges(tr.changes);
    if (update.docChanged || update.selectionSet || update.viewportChanged || this.needsRedraw) {
      this.needsRedraw = false;
      this.decorations = cursorDecorations(update.view, this.editor);
      this.selections = selectionDecorations(update.view);
    }
    // A tap or a change made elsewhere ends whatever was waiting for a key.
    if (!this.dispatching && update.transactions.some((tr) => tr.isUserEvent("select.pointer"))) {
      this.handler.dismissPending();
    }
  }

  private needsRedraw = false;

  /** Shows the editor's state after a change outside a transaction, such as its mode. */
  private refresh(): void {
    if (this.destroyed) return;
    this.needsRedraw = true;
    this.panel.render();
    // Changes can come from within an update, such as a tap dismissing a pending key, when
    // dispatching isn't allowed, so the view catches up just after.
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.destroyed) return;
      const mode = this.editor.mode;
      this.dispatch(
        this.view.state.field(modeField) !== mode ? { effects: modeChanged.of(mode) } : {},
      );
    });
  }

  private refreshQueued = false;

  private afterKey(): void {
    if (this.destroyed) return;
    const request = this.scrollRequest;
    this.scrollRequest = null;
    if (request?.kind === "lines") {
      this.view.scrollDOM.scrollTop += request.lines * this.view.defaultLineHeight;
    }
    const pos =
      request?.kind === "align" || request?.kind === "horizontal-center"
        ? request.pos
        : helixCursor(this.view.state);
    const align = request?.kind === "align" ? request.align : null;
    this.scrollToShow(pos, align, request?.kind === "horizontal-center");
  }

  /**
   * The part of the code that can be seen: the scroller, less anything over it such as a phone's
   * on-screen keyboard, in the window's coordinates.
   */
  private visibleArea(): { top: number; bottom: number; left: number; right: number } {
    const rect = this.view.scrollDOM.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = Math.max(rect.top, vv ? vv.offsetTop : 0);
    const bottom = Math.min(rect.bottom, vv ? vv.offsetTop + vv.height : window.innerHeight);
    const gutters = this.view.dom.querySelector(".cm-gutters")?.getBoundingClientRect();
    const left = Math.max(rect.left, gutters?.right ?? rect.left);
    const right = Math.min(rect.right, vv ? vv.offsetLeft + vv.width : window.innerWidth);
    return { top, bottom: Math.max(top, bottom), left, right: Math.max(left, right) };
  }

  /**
   * Scrolls the code, only as far as needed, so `pos` is in view with Helix's scrolloff around
   * it, or lines it up with the top, centre or bottom. Helix keeps the scrolloff to less than
   * half the view, so the cursor can always settle somewhere without the view moving again.
   */
  private scrollToShow(
    pos: number,
    align: "top" | "center" | "bottom" | null,
    centerX: boolean,
  ): void {
    const view = this.view;
    const coords = view.coordsAtPos(pos, 1) ?? view.coordsAtPos(pos, -1);
    if (coords === null) {
      // Not drawn yet, being far from what's in view, so CodeMirror measures and scrolls to it.
      this.dispatch({
        effects: EditorView.scrollIntoView(pos, {
          y: align === "top" ? "start" : align === "bottom" ? "end" : "center",
        }),
      });
      return;
    }
    const area = this.visibleArea();
    const lineHeight = view.defaultLineHeight;
    const lines = Math.floor((area.bottom - area.top) / lineHeight);
    const margin =
      Math.min(this.editor.options.scrolloff, Math.max(0, Math.floor((lines - 1) / 2))) *
      lineHeight;
    let dy = 0;
    if (align === "top") dy = coords.top - (area.top + margin);
    else if (align === "bottom") dy = coords.bottom - (area.bottom - margin);
    else if (align === "center")
      dy = (coords.top + coords.bottom) / 2 - (area.top + area.bottom) / 2;
    else if (coords.top < area.top + margin) dy = coords.top - (area.top + margin);
    else if (coords.bottom > area.bottom - margin) dy = coords.bottom - (area.bottom - margin);
    if (dy !== 0) view.scrollDOM.scrollTop += dy;
    if (this.softWrap()) return;
    const sideMargin = view.defaultCharacterWidth;
    let dx = 0;
    if (centerX) dx = (coords.left + coords.right) / 2 - (area.left + area.right) / 2;
    else if (coords.left < area.left + sideMargin) dx = coords.left - (area.left + sideMargin);
    else if (coords.right > area.right - sideMargin) dx = coords.right - (area.right - sideMargin);
    if (dx !== 0) view.scrollDOM.scrollLeft += dx;
  }

  /**
   * Text from an on-screen keyboard, which comes as input rather than key presses, goes to Helix
   * as the keys it stands for: typing, and Backspace and Enter in particular, which would
   * otherwise change the text over Helix's selection rather than at its cursor.
   */
  private readonly onBeforeInput = (event: InputEvent): void => {
    // Composing, such as an accented letter or a word on some keyboards, is left to the browser
    // and CodeMirror, and what it makes reaches Helix as a change to the page.
    if (event.isComposing || event.inputType === "insertCompositionText") return;
    // CodeMirror reads some of these as key presses still to come on phones, which would repeat
    // what Helix does with them.
    event.stopPropagation();
    // What can't be stopped changes the page, which also reaches Helix as a change to the page.
    if (!event.cancelable) return;
    if (this.echoesHandledKey()) {
      event.preventDefault();
      return;
    }
    let work: Promise<void> | null = null;
    switch (event.inputType) {
      case "insertText":
      case "insertReplacementText":
        if (event.data) work = this.handler.type(event.data);
        break;
      case "insertParagraph":
      case "insertLineBreak":
        work = this.handler.handle("ret" as Key);
        break;
      case "deleteContentBackward":
        work = this.handler.handle("backspace" as Key);
        break;
      case "deleteContentForward":
        work = this.handler.handle("del" as Key);
        break;
      case "deleteWordBackward":
        work = this.handler.handle("A-backspace" as Key);
        break;
      case "deleteWordForward":
        work = this.handler.handle("A-del" as Key);
        break;
      case "deleteSoftLineBackward":
      case "deleteHardLineBackward":
        work = this.editor.mode === "insert" ? this.handler.handle("C-u" as Key) : null;
        break;
      case "deleteSoftLineForward":
      case "deleteHardLineForward":
        work = this.editor.mode === "insert" ? this.handler.handle("C-k" as Key) : null;
        break;
      case "historyUndo":
      case "historyRedo":
        // The browser's own history doesn't know Helix's changes.
        work = null;
        break;
      default:
        if (event.inputType.startsWith("insertFrom")) {
          // Dropped or pasted text goes in as Helix pastes, rather than running as keys.
          const text = event.dataTransfer?.getData("text/plain") ?? event.data;
          if (text) work = this.handler.paste(text, pasteImpl);
        } else if (event.inputType.startsWith("format")) {
          // Code has no bold or italics.
          work = null;
        } else {
          return;
        }
    }
    event.preventDefault();
    if (work) run(this, work);
  };

  private readonly onViewportResize = (): void => {
    if (this.view.hasFocus) this.scrollToShow(helixCursor(this.view.state), null, false);
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !this.view.hasFocus) return;
    if (onKeyDown(event, this)) {
      event.stopPropagation();
      this.keyHandledAt = Date.now();
    }
  };

  /**
   * When Helix last took a key press. Some on-screen keyboards, such as an iPhone's for Backspace,
   * carry on with a key Helix has taken, and edit the page too, which mustn't count again.
   */
  private keyHandledAt = 0;

  /** Whether input now comes from a key Helix has just taken. */
  echoesHandledKey(): boolean {
    return Date.now() - this.keyHandledAt < 50;
  }

  destroy(): void {
    this.destroyed = true;
    this.view.dom.removeEventListener("keydown", this.onKey, true);
    this.view.dom.removeEventListener("beforeinput", this.onBeforeInput, true);
    window.visualViewport?.removeEventListener("resize", this.onViewportResize);
  }

  // ---- Host ----

  viewport(): { firstLine: number; lastLine: number; height: number } {
    const view = this.view;
    const area = this.visibleArea();
    const top = area.top - view.documentTop;
    const bottom = area.bottom - view.documentTop;
    const doc = view.state.doc;
    const firstBlock = view.lineBlockAtHeight(Math.max(0, top));
    const lastBlock = view.lineBlockAtHeight(Math.max(0, bottom - 1));
    let firstLine = doc.lineAt(firstBlock.from).number - 1;
    if (firstBlock.top < top - 1 && firstLine < doc.lines - 1) firstLine++;
    let lastLine = doc.lineAt(lastBlock.from).number - 1;
    if (lastBlock.bottom > bottom + 1 && lastLine > firstLine) lastLine--;
    const height = Math.max(1, Math.floor((bottom - top) / view.defaultLineHeight));
    return { firstLine, lastLine: Math.max(firstLine, lastLine), height };
  }

  bottomInset = 0;

  scroll(request: ScrollRequest): void {
    this.scrollRequest = request;
  }

  softWrap(): boolean {
    return this.config.actions.lineWrapping();
  }

  setSoftWrap(enabled: boolean): void {
    this.config.actions.setLineWrapping(enabled);
  }

  moveVisually(
    pos: number,
    forward: boolean,
    goal: number | null,
  ): { pos: number; goal: number } | null {
    if (!this.softWrap()) return null;
    const start = EditorSelection.cursor(pos, 1, undefined, goal ?? undefined);
    const moved = this.view.moveVertically(start, forward);
    const coords = this.view.coordsAtPos(pos);
    return { pos: moved.head, goal: moved.goalColumn ?? goal ?? coords?.left ?? 0 };
  }

  async readClipboard(): Promise<string> {
    if (!navigator.clipboard?.readText) throw new Error("this browser can't read the clipboard");
    return navigator.clipboard.readText();
  }

  async writeClipboard(text: string): Promise<void> {
    if (!navigator.clipboard?.writeText)
      throw new Error("this browser can't write to the clipboard");
    await navigator.clipboard.writeText(text);
  }

  diagnostics(): readonly HelixDiagnostic[] {
    const out: HelixDiagnostic[] = [];
    forEachDiagnostic(this.view.state, (d, from, to) => out.push({ from, to, message: d.message }));
    return out.sort((a, b) => a.from - b.from || a.to - b.to);
  }

  languageIndent(pos: number): number | null {
    const state = this.view.state;
    return getIndentation(new IndentContext(state, { simulateBreak: pos }), pos);
  }

  commentTokens() {
    const language = LANGUAGES[this.config.language] ?? PLAIN_TEXT;
    return { line: language.lineComments, block: language.blockComments };
  }

  undo(): boolean {
    return undo(this.view);
  }

  redo(): boolean {
    return redo(this.view);
  }

  async action(name: HostAction): Promise<void> {
    const editor = this.editor;
    const view = this.view;
    const lsp = this.config.lsp;
    const needsLsp = (run: () => unknown) => {
      if (lsp === null) {
        editor.setError("There's no language server running for this language");
        return;
      }
      run();
    };
    switch (name) {
      case "write":
        await this.config.actions.write();
        editor.setStatus(`'${this.documentName}' written`);
        return;
      case "reload":
        await this.config.actions.reload();
        return;
      case "format":
        needsLsp(() => formatDocument(view));
        return;
      case "goto_definition":
        needsLsp(() => jumpToDefinition(view));
        return;
      case "goto_declaration":
        needsLsp(() => jumpToDeclaration(view));
        return;
      case "goto_type_definition":
        needsLsp(() => jumpToTypeDefinition(view));
        return;
      case "goto_implementation":
        needsLsp(() => jumpToImplementation(view));
        return;
      case "goto_reference":
        needsLsp(() => findReferences(view));
        return;
      case "rename_symbol":
        needsLsp(() => renameSymbol(view));
        return;
      case "signature_help":
        needsLsp(() => showSignatureHelp(view));
        return;
      case "completion":
        needsLsp(() => startCompletion(view));
        return;
      case "hover":
        if (lsp === null) {
          editor.setError("There's no language server running for this language");
          return;
        }
        await this.hover(lsp.client, lsp.uri);
        return;
      case "select_references_to_symbol_under_cursor":
        if (lsp === null) {
          editor.setError("There's no language server running for this language");
          return;
        }
        await this.selectReferences(lsp.client, lsp.uri);
        return;
      case "symbol_picker":
        if (lsp === null) {
          editor.setError("There's no language server running for this language");
          return;
        }
        await this.symbolPicker(lsp.client, lsp.uri);
        return;
      case "code_action":
        editor.setError(
          "code_action isn't available in Workshop: its language client has no code actions",
        );
        return;
    }
  }

  private position(pos: number): { line: number; character: number } {
    const line = this.view.state.doc.lineAt(pos);
    return { line: line.number - 1, character: pos - line.from };
  }

  private offset(position: { line: number; character: number }): number {
    const doc = this.view.state.doc;
    const line = doc.line(Math.min(position.line + 1, doc.lines));
    return Math.min(line.from + position.character, line.to);
  }

  private async hover(client: LSPClient, uri: string): Promise<void> {
    client.sync();
    const result = await client.request<unknown, { contents: unknown } | null>(
      "textDocument/hover",
      {
        textDocument: { uri },
        position: this.position(helixCursor(this.view.state)),
      },
    );
    const text = result ? hoverContents(result.contents).trim() : "";
    if (text === "") {
      this.editor.setStatus("No hover information available");
      return;
    }
    this.editor.autoinfo = {
      title: "Hover",
      body: text.split("\n").map((line) => ["", line] as const),
      kind: "text",
    };
    this.editor.onChange();
  }

  private async selectReferences(client: LSPClient, uri: string): Promise<void> {
    client.sync();
    const result = await client.request<
      unknown,
      | {
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
        }[]
      | null
    >("textDocument/documentHighlight", {
      textDocument: { uri },
      position: this.position(helixCursor(this.view.state)),
    });
    if (!result || result.length === 0) {
      this.editor.setStatus("No references found");
      return;
    }
    const cursor = helixCursor(this.view.state);
    const ranges = result.map((r) => ({
      from: this.offset(r.range.start),
      to: this.offset(r.range.end),
    }));
    const primary = Math.max(
      0,
      ranges.findIndex((r) => r.from <= cursor && cursor < r.to),
    );
    this.editor.setSelection(
      new Selection(
        ranges.map((r) => fromEditorSelection(EditorSelection.single(r.from, r.to)).primary),
        primary,
      ),
    );
    this.afterKey();
  }

  private async symbolPicker(client: LSPClient, uri: string): Promise<void> {
    client.sync();
    type Symbol = {
      name: string;
      kind: number;
      range?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      selectionRange?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      location?: {
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      };
      children?: Symbol[];
    };
    const result = await client.request<unknown, Symbol[] | null>("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    const flat: Symbol[] = [];
    const walk = (symbols: Symbol[]) => {
      for (const s of symbols) {
        flat.push(s);
        if (s.children) walk(s.children);
      }
    };
    walk(result ?? []);
    if (flat.length === 0) {
      this.editor.setStatus("No symbols found");
      return;
    }
    const cx = this.handler;
    const items = flat.map((s) => {
      const range = s.selectionRange ?? s.range ?? s.location?.range;
      return {
        label: s.name,
        detail: range ? `line ${range.start.line + 1}` : "",
        run: () => {
          if (range === undefined) return;
          const from = this.offset(range.start);
          const to = this.offset(range.end);
          this.editor.pushJump();
          this.editor.setSelection(Selection.single(from, to));
          this.scroll({ kind: "align", pos: from, align: "center" });
        },
      };
    });
    cx.openPicker("Symbols", items);
  }
}

function hoverContents(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverContents).join("\n");
  if (contents && typeof contents === "object" && "value" in contents) {
    return String((contents as { value: unknown }).value);
  }
  return "";
}

// ---- The status line ----

/** The mode, pending keys and messages under the code, and any prompt, picker or help. */
class StatusPanel {
  readonly dom: HTMLElement;
  private readonly status: HTMLElement;
  private readonly extra: HTMLElement;

  constructor(private readonly helix: HelixView) {
    this.dom = panelElement(helix.view);
    this.extra = document.createElement("div");
    this.extra.className = "cm-helix-extra";
    this.status = document.createElement("div");
    this.status.className = "cm-helix-status";
    // On a touch screen the whole status line is the escape key, so it needn't be hit exactly.
    // On pressing, which keeps the focus, and with it the keyboard, up; preventing that stops
    // Safari sending a click.
    this.status.addEventListener("pointerdown", (e) => {
      if (!window.matchMedia("(pointer: coarse)").matches) return;
      e.preventDefault();
      this.escape();
    });
    this.status.addEventListener("mousedown", (e) => {
      if (window.matchMedia("(pointer: coarse)").matches) e.preventDefault();
    });
    this.dom.append(this.extra, this.status);
    this.render();
  }

  render(): void {
    const { editor, handler } = this.helix;
    this.dom.style.marginBottom = `${this.helix.bottomInset}px`;
    this.extra.replaceChildren();
    if (editor.picker) {
      this.extra.append(
        renderPicker(editor, (index) => {
          if (editor.picker) editor.picker.selected = index;
          run(this.helix, this.helix.handler.handle("ret" as Key));
        }),
      );
    } else if (editor.autoinfo) this.extra.append(renderInfo(editor.autoinfo));
    this.status.replaceChildren();
    if (editor.prompt) {
      const prompt = editor.prompt;
      const label = span("cm-helix-prompt-label", prompt.label);
      const cursor = Math.min(handler.promptCursor, prompt.input.length);
      const input = span("cm-helix-prompt-input", "");
      input.append(
        document.createTextNode(prompt.input.slice(0, cursor)),
        span("cm-helix-prompt-cursor", prompt.input.slice(cursor, cursor + 1) || " "),
        document.createTextNode(prompt.input.slice(cursor + 1)),
      );
      this.status.append(label, input, this.escButton());
      return;
    }
    const mode = span(
      `cm-helix-mode cm-helix-mode-${editor.mode}${editor.options.colorModes ? " cm-helix-color-modes" : ""}`,
      MODE_NAMES[editor.mode],
    );
    const parts: HTMLElement[] = [mode];
    if (editor.macroRecording)
      parts.push(span("cm-helix-recording", `[${editor.macroRecording.register}]`));
    const selection = editor.selection;
    if (selection.length > 1) {
      parts.push(
        span("cm-helix-selections", `${selection.primaryIndex + 1}/${selection.length} selections`),
      );
    }
    const message = editor.status;
    if (message) {
      parts.push(
        span(message.severity === "error" ? "cm-helix-error" : "cm-helix-message", message.message),
      );
    }
    parts.push(span("cm-helix-pending", handler.pendingDisplay()), this.escButton());
    this.status.append(...parts);
  }

  /**
   * Escape, for an on-screen keyboard, which has no escape key. Shown on touch screens, where
   * pressing anywhere on the status line presses it, so it shows what that does.
   */
  private escButton(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-helix-esc";
    button.textContent = "esc";
    button.setAttribute("aria-label", "Escape");
    // Pressing it is pressing the status line; this is for a keyboard, which clicks without
    // pressing.
    button.addEventListener("click", (e) => {
      if (e.detail === 0) this.escape();
    });
    return button;
  }

  private escape(): void {
    run(this.helix, this.helix.handler.handle("esc" as Key));
  }
}

function span(className: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

function renderInfo(info: Info): HTMLElement {
  const box = document.createElement("div");
  box.className = `cm-helix-info cm-helix-info-${info.kind ?? "keys"}`;
  if (info.title) box.append(span("cm-helix-info-title", info.title));
  const table = document.createElement("div");
  table.className = "cm-helix-info-body";
  for (const [key, desc] of info.body) {
    table.append(span("cm-helix-info-key", key), span("cm-helix-info-desc", desc));
  }
  box.append(table);
  return box;
}

const PICKER_ROWS = 12;

/** The picker, whose rows run when tapped or clicked, with `pick` given the match's index. */
function renderPicker(editor: HelixEditor, pick: (index: number) => void): HTMLElement {
  const picker = editor.picker;
  const box = document.createElement("div");
  box.className = "cm-helix-picker";
  if (picker === null) return box;
  const matches = pickerMatches(picker);
  const query = span("cm-helix-picker-query", "");
  query.append(document.createTextNode(picker.query), span("cm-helix-prompt-cursor", " "));
  box.append(
    span("cm-helix-info-title", `${picker.title} (${matches.length}/${picker.items.length})`),
    query,
  );
  const start = Math.max(
    0,
    Math.min(picker.selected - Math.floor(PICKER_ROWS / 2), matches.length - PICKER_ROWS),
  );
  const list = document.createElement("div");
  list.className = "cm-helix-picker-list";
  matches.slice(start, start + PICKER_ROWS).forEach((item, i) => {
    const row = document.createElement("div");
    row.className = `cm-helix-picker-row${start + i === picker.selected ? " cm-helix-picker-selected" : ""}`;
    row.append(
      span("cm-helix-picker-label", item.label),
      span("cm-helix-picker-detail", item.detail),
    );
    // On pressing, so the focus, and a phone's keyboard, stay where they are.
    row.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pick(start + i);
    });
    list.append(row);
  });
  box.append(list);
  return box;
}

// ---- Handling keys ----

/** Whether a key is left to the browser, such as Cmd-R, rather than going to Helix. */
function leaveToBrowser(helix: HelixView, key: Key): boolean {
  const { editor, handler } = helix;
  const busy = editor.prompt !== null || editor.picker !== null;
  if (busy || handler.isBound(key)) return false;
  const parsed = unparseKey(key);
  // Browser shortcuts.
  if (parsed.meta) return true;
  if (editor.mode !== "insert") return false;
  // Unbound keys with modifiers type what the keyboard makes of them, such as Option-3 typing `#`
  // on a British Mac keyboard.
  if (parsed.alt || parsed.ctrl) return true;
  return keyChar(key) === null;
}

function onKeyDown(event: KeyboardEvent, helix: HelixView): boolean {
  const view = helix.view;
  // Completion's keys go to the completion list while it's open.
  if (completionStatus(view.state) === "active" && helix.editor.mode === "insert") {
    if (["Enter", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Tab"].includes(event.key))
      return false;
    if (event.key === "Escape") closeCompletion(view);
  }
  const key = keyFromEvent(event);
  if (key === null || leaveToBrowser(helix, key)) return false;
  event.preventDefault();
  run(helix, helix.handler.handle(key));
  return true;
}

function run(helix: HelixView, work: Promise<void>): void {
  work.catch((e: unknown) => {
    // A bug in a command: say so rather than leaving the editor silently stuck.
    console.error(e);
    helix.editor.setError(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
  });
}

/** The status line's element for each view, which exists before the plugin that fills it does. */
const panels = new WeakMap<EditorView, HTMLElement>();

function panelElement(view: EditorView): HTMLElement {
  let dom = panels.get(view);
  if (dom === undefined) {
    dom = document.createElement("div");
    dom.className = "cm-helix-panel";
    panels.set(view, dom);
  }
  return dom;
}

const theme = EditorView.theme({
  "&.cm-helix .cm-cursorLayer": { display: "none" },
  "&.cm-helix .cm-content": { caretColor: "transparent", WebkitTapHighlightColor: "transparent" },
  // The browser's own selection would cover Helix's cursors, as WebKit draws it on top.
  "&.cm-helix .cm-line::selection, &.cm-helix .cm-line ::selection": {
    background: "transparent !important",
  },
  // Helix shows selections clearly, and highlights no line of its own, which would hide them.
  "&.cm-helix .cm-activeLine": { background: "transparent" },
  "&.cm-helix .cm-selectionBackground, &.cm-helix.cm-focused .cm-selectionBackground": {
    background: "transparent !important",
  },
  ".cm-helix-selection": { background: "color-mix(in srgb, var(--accent) 30%, transparent)" },
  ".cm-helix-cursor-block": {
    background: "color-mix(in srgb, var(--helix-cursor) 45%, transparent)",
    outline: "1px solid var(--helix-cursor)",
    borderRadius: "1px",
  },
  ".cm-helix-cursor-block.cm-helix-cursor-primary": {
    background: "var(--helix-cursor)",
    color: "var(--bg)",
  },
  ".cm-helix-cursor-bar": { boxShadow: "inset 2px 0 0 var(--helix-cursor)" },
  ".cm-helix-cursor-underline": { boxShadow: "inset 0 -2px 0 var(--helix-cursor)" },
  "&": { "--helix-cursor": "var(--accent)" },
  "&.cm-helix-color-modes.cm-helix-insert": { "--helix-cursor": "var(--syntax-string)" },
  "&.cm-helix-color-modes.cm-helix-select": { "--helix-cursor": "var(--syntax-number)" },
  ".cm-helix-jump-label": {
    color: "var(--error)",
    fontWeight: "bold",
  },
  ".cm-panels-bottom": { borderTop: "none", background: "transparent" },
  ".cm-helix-panel": {
    color: "var(--fg)",
    fontFamily: "var(--mono)",
    fontSize: "0.85em",
    background: "var(--surface)",
    borderTop: "1px solid var(--border)",
  },
  ".cm-helix-status": {
    display: "flex",
    gap: "1ch",
    alignItems: "baseline",
    padding: "2px 1ch",
    minHeight: "1.5em",
    whiteSpace: "pre",
    overflow: "hidden",
  },
  ".cm-helix-mode": { fontWeight: "bold", padding: "0 1ch" },
  ".cm-helix-mode.cm-helix-color-modes": { color: "var(--accent-fg)", background: "var(--accent)" },
  ".cm-helix-mode-insert.cm-helix-color-modes": { background: "var(--syntax-string)" },
  ".cm-helix-mode-select.cm-helix-color-modes": { background: "var(--syntax-number)" },
  ".cm-helix-pending": { marginLeft: "auto", color: "var(--muted)" },
  ".cm-helix-recording, .cm-helix-selections": { color: "var(--muted)" },
  ".cm-helix-error": { color: "var(--error)" },
  ".cm-helix-message": { color: "var(--fg)" },
  ".cm-helix-prompt-cursor": { background: "var(--accent)", color: "var(--accent-fg)" },
  ".cm-helix-extra:empty": { display: "none" },
  ".cm-helix-info, .cm-helix-picker": {
    padding: "4px 1ch",
    borderBottom: "1px solid var(--border)",
    maxHeight: "40vh",
    overflow: "auto",
  },
  ".cm-helix-info-title": { display: "block", fontWeight: "bold", marginBottom: "2px" },
  ".cm-helix-info-body": {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "2ch",
    whiteSpace: "pre-wrap",
  },
  ".cm-helix-info-key": { color: "var(--accent)" },
  ".cm-helix-esc": {
    display: "none",
    marginLeft: "1ch",
    padding: "0 1.5ch",
    font: "inherit",
    color: "var(--fg)",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    touchAction: "manipulation",
  },
  // On a phone: an escape key, as on-screen keyboards have none, which the whole status line
  // presses, and no key help, which would take up most of the screen.
  "@media (pointer: coarse)": {
    ".cm-helix-status": { cursor: "pointer", touchAction: "manipulation" },
    ".cm-helix-esc": { display: "inline-block" },
    ".cm-helix-info-keys": { display: "none" },
    ".cm-helix-info-text, .cm-helix-picker": { maxHeight: "30vh" },
  },
  ".cm-helix-picker-query": { display: "block", marginBottom: "2px" },
  ".cm-helix-picker-row": { display: "flex", gap: "2ch", whiteSpace: "pre", overflow: "hidden" },
  ".cm-helix-picker-selected": { background: "var(--selection)" },
  ".cm-helix-picker-detail": {
    color: "var(--muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

/** The plugin for a view with Helix's keybindings, if it has them. */
let activePlugin: ViewPlugin<HelixView> | null = null;

/** Helix's keybindings, with the editor model and everything shown for them. */
export function helixKeybindings(config: HelixConfig): Extension {
  const plugin = ViewPlugin.define((view) => new HelixView(view, config), {
    decorations: (v) => v.decorations,
  });
  activePlugin = plugin;
  const withHelix = <T>(view: EditorView, f: (helix: HelixView) => T, otherwise: T): T => {
    const helix = view.plugin(plugin);
    return helix ? f(helix) : otherwise;
  };
  return [
    modeField,
    keepSelectionsWide,
    EditorState.allowMultipleSelections.of(true),
    helixHistory(),
    insertSelectionField,
    plugin,
    // Outside the cursors' marks, so a cursor shows over the selection it's in.
    Prec.high(
      EditorView.decorations.of((view) => view.plugin(plugin)?.selections ?? Decoration.none),
    ),
    showPanel.of((view): Panel => ({ dom: panelElement(view) })),
    Prec.highest(
      EditorView.domEventHandlers({
        paste: (event, view) =>
          withHelix(
            view,
            (helix) => {
              const text = event.clipboardData?.getData("text/plain");
              if (text === undefined || text === "") return false;
              event.preventDefault();
              run(helix, helix.handler.paste(text, pasteImpl));
              return true;
            },
            false,
          ),
      }),
    ),
    // Text typed other than by key presses Helix sees, such as by composing an accented letter
    // or an on-screen keyboard, is typed as if its keys had been pressed.
    // Changes made to the page before Helix could see them as keys, such as by a keyboard
    // composing a word, go to Helix as the keys they stand for: deleting as backspaces, in insert
    // mode, then typing. Not applying the change itself has CodeMirror put the page back.
    EditorView.inputHandler.of((view, from, to, text) =>
      withHelix(
        view,
        (helix) => {
          if (helix.echoesHandledKey()) return true;
          let work = Promise.resolve();
          if (helix.editor.mode === "insert") {
            // In insert mode the page's caret is at Helix's cursor, so what went before it was
            // backspaced, and what went after it deleted forwards.
            const cursor = helixCursor(view.state);
            const before = graphemes(
              view.state.sliceDoc(from, Math.max(from, Math.min(to, cursor))),
            );
            const after = graphemes(view.state.sliceDoc(Math.min(to, Math.max(from, cursor)), to));
            for (const _ of before) work = helix.handler.handle("backspace" as Key);
            for (const _ of after) work = helix.handler.handle("del" as Key);
          }
          if (text !== "") work = helix.handler.type(text);
          run(helix, work);
          return true;
        },
        false,
      ),
    ),
    EditorView.editorAttributes.compute([modeField], (state) => {
      const mode = state.field(modeField);
      return { class: `cm-helix cm-helix-${mode}` };
    }),
    EditorView.editorAttributes.of((view) =>
      withHelix(
        view,
        (helix) => (helix.editor.options.colorModes ? { class: "cm-helix-color-modes" } : null),
        null,
      ),
    ),
    config.lsp
      ? autocompletion({ override: [serverCompletionSource], activateOnTyping: false })
      : [],
    theme,
  ];
}

/** Keeps the status line clear of what floats over the bottom of the editor. */
export function setHelixBottomInset(view: EditorView, px: number): void {
  const helix = activePlugin ? view.plugin(activePlugin) : null;
  if (!helix) return;
  helix.bottomInset = px;
  helix.panelDom.render();
}

/** The Helix editor in a view, if it has Helix's keybindings, for tests and the app. */
export function helixIn(view: EditorView): { editor: HelixEditor; handler: KeyHandler } | null {
  const helix = activePlugin ? view.plugin(activePlugin) : null;
  return helix ? { editor: helix.editor, handler: helix.handler } : null;
}
