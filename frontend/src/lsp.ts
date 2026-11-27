import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { LSPClient, LSPPlugin, type Transport } from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { errorMessage } from "./errors";
import { EXTRA_CAPABILITIES, isRecord } from "./lspActions";
import { serverCompletionSource } from "./lspCompletion";
import { renderMarkdown } from "./markdown";

interface Message {
  method?: string;
  params?: { capabilities?: Record<string, unknown> & { textDocument?: Record<string, unknown> } };
}

/** Adds `extra` to `target`, keeping what's in each of its sections that `extra` doesn't set. */
function merge(target: Record<string, unknown>, extra: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(extra)) {
    const existing = target[key];
    if (isRecord(existing) && isRecord(value)) merge(existing, value);
    else target[key] = value;
  }
}

/**
 * Changes the capabilities the client offers as it connects, to what Workshop does with it.
 *
 * Pull diagnostics go: the client offers them but only shows the diagnostics a server sends
 * unasked, and servers that can be asked, such as Deno's, then wait to be asked and send nothing.
 * Code actions are added, which Workshop asks for itself, along with what Workshop does to finish
 * a completion: asking for its other edits, and making edits the server asks for.
 */
export function adjustCapabilities(message: string): string {
  const parsed = JSON.parse(message) as Message;
  if (parsed.method !== "initialize") return message;
  const capabilities = parsed.params?.capabilities;
  if (capabilities?.textDocument === undefined) {
    throw new Error("the language client connected without saying what it can do");
  }
  delete capabilities.textDocument.diagnostic;
  merge(capabilities, EXTRA_CAPABILITIES);
  return JSON.stringify(parsed);
}

/** The `window/showMessage` type of an error. */
const MESSAGE_ERROR = 1;

/**
 * The error in a language server's `window/showMessage` to show, or null if it's kept to the
 * console. Servers announce routine progress this way, such as gopls's "Finished loading
 * packages", so only errors are shown, and not while the server's formatting: some report its
 * failures this way as well as in answer, such as haskell-language-server for code that doesn't
 * parse yet, and formatting says itself if it fails.
 */
export function messageToShow(
  params: { type: number; message: string },
  formatting: boolean,
): string | null {
  if (params.type === MESSAGE_ERROR && !formatting) return params.message;
  console.info(`[lsp] ${params.message}`);
  return null;
}

/** How long typing has to pause for before completions come up unasked. */
export const COMPLETION_DELAY_MS = 400;

/** How much of a word has to be typed before completions come up for it unasked. */
export const COMPLETION_MIN_WORD = 2;

/**
 * Whether completions should come up unasked here: once enough of a word's been typed, or after
 * what isn't part of a word, such as a `.`, which the server says whether it completes after.
 */
export function typedEnoughToComplete(textBefore: string): boolean {
  const word = /[\w']*$/.exec(textBefore)?.[0] ?? "";
  return word.length === 0 || word.length >= COMPLETION_MIN_WORD;
}

/**
 * The language server's completions, as they're asked for or, unasked, once typing pauses, so
 * a word typed in one go isn't covered by a list of what it could be. `unasked` says where else
 * they may come up unasked.
 */
export function languageServerCompletion(options: {
  selectOnOpen: boolean;
  unasked?: (context: CompletionContext) => boolean;
}): Extension {
  const { selectOnOpen, unasked = () => true } = options;
  return autocompletion({
    override: [
      (context) =>
        context.explicit ||
        (unasked(context) &&
          typedEnoughToComplete(
            context.state.sliceDoc(Math.max(0, context.pos - 100), context.pos),
          ))
          ? serverCompletionSource(context)
          : null,
    ],
    activateOnTypingDelay: COMPLETION_DELAY_MS,
    selectOnOpen,
  });
}

/**
 * A request to the language server that failed: the server answered with an error, didn't answer
 * in time, or the connection to it is gone. These are the server's doing, not bugs in Workshop.
 */
export class LanguageServerError extends Error {
  override readonly name = "LanguageServerError";

  constructor(
    message: string,
    /** The JSON-RPC error code, when the server answered with an error. */
    readonly code: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  /**
   * The error for what a request was rejected with, which the library leaves as the server sent
   * it when the server answers with an error: an object with a code and a message, not an Error.
   */
  static from(reason: unknown): LanguageServerError {
    if (reason instanceof LanguageServerError) return reason;
    const code =
      isRecord(reason) && !(reason instanceof Error) && typeof reason.code === "number"
        ? reason.code
        : null;
    return new LanguageServerError(errorMessage(reason), code, { cause: reason });
  }
}

/**
 * Renders an LSP documentation string or `MarkupContent` as HTML safe to insert into tooltips.
 * Markdown goes through Workshop's renderer so raw HTML is escaped and unsafe links are dropped.
 */
export function lspDocToHtml(
  value: string | { readonly kind: "markdown" | "plaintext"; readonly value: string },
  defaultKind: "markdown" | "plaintext" = "plaintext",
): string {
  const kind = typeof value === "string" ? defaultKind : value.kind;
  const text = typeof value === "string" ? value : value.value;
  if (kind === "plaintext") {
    return text.replace(/[\n<&>"]/g, (ch) =>
      ch === "\n"
        ? "<br>"
        : ch === "<"
          ? "&lt;"
          : ch === ">"
            ? "&gt;"
            : ch === '"'
              ? "&quot;"
              : "&amp;",
    );
  }
  return renderMarkdown(text);
}

/**
 * The language client, with nothing it does left to fail unhandled, and requests that only ever
 * fail with a `LanguageServerError`.
 *
 * The library sends notifications, such as of a file being opened or changed, once the server's
 * greeted, but if the connection closes first, the greeting fails 30 seconds later, and every
 * notification waiting on it with it, where nothing can catch that. Here they're dropped
 * instead, with the connection. Once the server's been given up on, requests fail at once,
 * rather than waiting for a server that isn't coming.
 */
export class LanguageClient extends LSPClient {
  private sending: Transport | null = null;
  /** Why the language server can't be used, once it's been given up on. */
  unavailable: string | null = null;

  override plugin(fileURI: string, languageID?: string): Extension {
    return [
      super.plugin(fileURI, languageID),
      ViewPlugin.define((view) => {
        const plugin = LSPPlugin.get(view);
        if (plugin === null) {
          throw new Error("LSPPlugin missing after LanguageClient.plugin");
        }
        plugin.docToHTML = lspDocToHtml;
        return {};
      }),
    ];
  }

  override connect(transport: Transport): this {
    this.sending = transport;
    super.connect(transport);
    // Whoever waits on the greeting handles its failing; this is for when nobody is.
    this.initializing.catch(() => {});
    return this;
  }

  override disconnect(): void {
    this.sending = null;
    super.disconnect();
  }

  override notification<Params>(method: string, params: Params): void {
    if (this.sending === null) return;
    this.initializing.then(
      () => this.sending?.send(JSON.stringify({ jsonrpc: "2.0", method, params })),
      () => {},
    );
  }

  override request<Params, Result>(method: string, params: Params): Promise<Result> {
    if (this.unavailable !== null) {
      return Promise.reject(
        new LanguageServerError(`the language server is unavailable: ${this.unavailable}`),
      );
    }
    return super.request<Params, Result>(method, params).catch((reason: unknown) => {
      throw LanguageServerError.from(reason);
    });
  }
}
