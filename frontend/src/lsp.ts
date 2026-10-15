interface Message {
  method?: string;
  params?: { capabilities?: { textDocument?: { diagnostic?: unknown } } };
}

/**
 * Takes pull diagnostics out of the capabilities the client offers as it connects. The client
 * offers them but only shows the diagnostics a server sends unasked, and servers that can be
 * asked, such as Deno's, then wait to be asked and send nothing.
 */
export function withoutPullDiagnostics(message: string): string {
  const parsed = JSON.parse(message) as Message;
  if (parsed.method !== "initialize") return message;
  delete parsed.params?.capabilities?.textDocument?.diagnostic;
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
