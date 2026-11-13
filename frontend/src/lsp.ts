import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { serverCompletionSource } from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import { EXTRA_CAPABILITIES } from "./lspActions";

interface Message {
  method?: string;
  params?: { capabilities?: { textDocument?: Record<string, unknown> } };
}

/**
 * Changes the capabilities the client offers as it connects, to what Workshop does with it.
 *
 * Pull diagnostics go: the client offers them but only shows the diagnostics a server sends
 * unasked, and servers that can be asked, such as Deno's, then wait to be asked and send nothing.
 * Code actions are added, which Workshop asks for itself.
 */
export function adjustCapabilities(message: string): string {
  const parsed = JSON.parse(message) as Message;
  if (parsed.method !== "initialize") return message;
  const textDocument = parsed.params?.capabilities?.textDocument;
  if (textDocument === undefined) {
    throw new Error("the language client connected without saying what it can do");
  }
  delete textDocument.diagnostic;
  Object.assign(textDocument, EXTRA_CAPABILITIES);
  return JSON.stringify(parsed);
}

/** The `window/showMessage` type of an error. */
const MESSAGE_ERROR = 1;

/**
 * Keeps a language server's message to itself unless it's an error, as servers announce routine
 * progress this way, such as gopls's "Finished loading packages", which would otherwise cover the
 * code. Returns whether the message was handled, so the client doesn't show it.
 */
export function quietMessage(params: { type: number; message: string }): boolean {
  if (params.type === MESSAGE_ERROR) return false;
  console.info(`[lsp] ${params.message}`);
  return true;
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
