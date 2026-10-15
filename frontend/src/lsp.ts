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
