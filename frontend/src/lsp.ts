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
