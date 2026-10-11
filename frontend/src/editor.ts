import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { forEachDiagnostic, nextDiagnostic, previousDiagnostic } from "@codemirror/lint";
import { LSPClient, serverDiagnostics, type Transport } from "@codemirror/lsp-client";
import {
  Compartment,
  EditorSelection,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { markCursor, minimalChange, unmarkCursor } from "./diff";

const LANGUAGES: Record<string, () => Extension> = {
  haskell: () => StreamLanguage.define(haskell),
};

const highlightStyle = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword],
    color: "var(--syntax-keyword)",
  },
  { tag: [tags.string, tags.character], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.atom], color: "var(--syntax-number)" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--muted)",
    fontStyle: "italic",
  },
  { tag: [tags.typeName, tags.className], color: "var(--syntax-type)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--syntax-operator)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--code-size)",
    background: "transparent",
    color: "var(--fg)",
  },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55", overscrollBehavior: "contain" },
  ".cm-content": { caretColor: "var(--accent)", paddingBottom: "40vh" },
  ".cm-cursor": { borderLeft: "2px solid var(--accent)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-gutters": { background: "transparent", border: "none", color: "var(--faint)" },
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
  errors: number;
  warnings: number;
}

export interface EditorOptions {
  doc: string;
  cursor: number | null;
  mode: string;
  lsp: { client: LSPClient; uri: string; languageId: string } | null;
  onChange: (text: string) => void;
  onCursor: (pos: number) => void;
  onDiagnostics: (diagnostics: Diagnostics) => void;
}

export class CodeEditor {
  readonly view: EditorView;
  private readonly inputMode = new Compartment();
  private flashTimer: number | undefined;
  /** The text most recently inserted by voice, which "that" refers to. */
  recentInsertion: string | null = null;

  constructor(parent: HTMLElement, options: EditorOptions) {
    const language = LANGUAGES[options.mode];
    const cursor = Math.min(options.cursor ?? 0, options.doc.length);
    this.view = new EditorView({
      parent,
      doc: options.doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(highlightStyle),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        theme,
        changedField,
        language ? language() : [],
        options.lsp ? [options.lsp.client.plugin(options.lsp.uri, options.lsp.languageId)] : [],
        this.inputMode.of(EditorView.contentAttributes.of({ inputmode: "none" })),
        EditorView.updateListener.of((update) => {
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
            options.onCursor(update.state.selection.main.head);
          }
          const diagnostics = countDiagnostics(update.view);
          options.onDiagnostics(diagnostics);
        }),
      ],
    });
    this.view.dispatch({ effects: EditorView.scrollIntoView(cursor, { y: "center" }) });
  }

  /** Shows the on-screen keyboard for typing, or hides it so taps only move the cursor. */
  setKeyboard(enabled: boolean): void {
    this.view.dispatch({
      effects: this.inputMode.reconfigure(
        EditorView.contentAttributes.of({ inputmode: enabled ? "text" : "none" }),
      ),
    });
    if (enabled) {
      this.view.focus();
    }
  }

  text(): string {
    return this.view.state.doc.toString();
  }

  markedText(): string {
    return markCursor(this.text(), this.view.state.selection.main.head);
  }

  /** Applies a document with a cursor marker as one undoable change. */
  applyMarked(marked: string): void {
    const { text, cursor } = unmarkCursor(marked);
    const change = minimalChange(this.text(), text);
    this.view.dispatch({
      changes: change ?? [],
      selection: EditorSelection.cursor(cursor),
      scrollIntoView: true,
      userEvent: "input.voice",
    });
    if (change) {
      const end = change.from + change.insert.length;
      this.recentInsertion = change.insert.trim() || null;
      this.flash(change.from, end);
    }
  }

  insertSnippet(body: string): void {
    const { from, to } = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from, to, insert: body },
      selection: EditorSelection.cursor(from + body.length),
      scrollIntoView: true,
      userEvent: "input.snippet",
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

  nextError(): void {
    nextDiagnostic(this.view);
  }

  previousError(): void {
    previousDiagnostic(this.view);
  }

  diagnosticsText(): string {
    const lines: string[] = [];
    forEachDiagnostic(this.view.state, (d, from) => {
      const line = this.view.state.doc.lineAt(from).number;
      lines.push(`line ${line} (${d.severity}): ${d.message}`);
    });
    return lines.join("\n");
  }

  /** Words in the file, used to help speech recognition hear identifiers. */
  identifiers(): string[] {
    const words = new Set(this.text().match(/[A-Za-z_][A-Za-z0-9_']{2,}/g) ?? []);
    return [...words];
  }

  destroy(): void {
    window.clearTimeout(this.flashTimer);
    this.view.destroy();
  }
}

function countDiagnostics(view: EditorView): Diagnostics {
  const counts = { errors: 0, warnings: 0 };
  forEachDiagnostic(view.state, (d) => {
    if (d.severity === "error") counts.errors++;
    else if (d.severity === "warning") counts.warnings++;
  });
  return counts;
}

class SocketTransport implements Transport {
  private readonly handlers = new Set<(value: string) => void>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        for (const handler of this.handlers) handler(event.data);
      }
    });
  }

  send(message: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message);
    }
  }

  subscribe(handler: (value: string) => void): void {
    this.handlers.add(handler);
  }

  unsubscribe(handler: (value: string) => void): void {
    this.handlers.delete(handler);
  }
}

/** Connects to the language server through Workshop's websocket relay. */
export async function connectLanguageServer(
  rootUri: string,
  onClose: () => void,
): Promise<LSPClient> {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/api/lsp`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Couldn't connect to the language server.")),
      {
        once: true,
      },
    );
  });
  const client = new LSPClient({
    rootUri,
    timeout: 30_000,
    extensions: [serverDiagnostics()],
  });
  socket.addEventListener("close", () => {
    client.disconnect();
    onClose();
  });
  client.connect(new SocketTransport(socket));
  return client;
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
