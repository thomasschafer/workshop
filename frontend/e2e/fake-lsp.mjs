// A stand-in for a language server, so the browser tests need none installed. It knows nothing
// of Python: it works on words. Every `oops` in the file is an error, with a message of several
// lines, and every `hmm` a warning. A word's definition is its first appearance, its references
// are all of them, and renaming it changes each. It completes a word to the file's other words. Over an `oops`, it offers to remove it, sending
// the edit only once that's chosen, and to shout it, with the edit straight away.

const documents = new Map();

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

const position = (text, offset) => {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length - 1, character: before.at(-1).length };
};
const offsetOf = (text, { line, character }) =>
  text.split("\n").slice(0, line).join("\n").length + (line > 0 ? 1 : 0) + character;
const rangeOf = (text, from, to) => ({ start: position(text, from), end: position(text, to) });

/** Where each whole-word appearance of `word` starts. */
function appearances(text, word) {
  const found = [];
  for (const match of text.matchAll(new RegExp(`\\b${word}\\b`, "g"))) found.push(match.index);
  return found;
}

function wordAt(text, offset) {
  let from = offset;
  let to = offset;
  while (from > 0 && /\w/.test(text[from - 1])) from--;
  while (to < text.length && /\w/.test(text[to])) to++;
  return from === to ? null : { from, to, word: text.slice(from, to) };
}

function diagnose(uri) {
  const text = documents.get(uri);
  const diagnostics = [
    ...appearances(text, "oops").map((from) => ({
      range: rangeOf(text, from, from + 4),
      severity: 1,
      source: "fake",
      message: `oops isn't a thing\n${"It was never defined anywhere in this file. ".repeat(12)}\nlast line of the error`,
    })),
    ...appearances(text, "hmm").map((from) => ({
      range: rangeOf(text, from, from + 3),
      severity: 2,
      source: "fake",
      message: "hmm looks doubtful",
    })),
  ];
  send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
}

const handlers = {
  initialize: () => ({
    capabilities: {
      textDocumentSync: 1,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: true,
      hoverProvider: true,
      codeActionProvider: { resolveProvider: true },
      completionProvider: {},
    },
  }),
  shutdown: () => null,
  "textDocument/definition": ({ textDocument: { uri }, position: at }) => {
    const text = documents.get(uri);
    const word = wordAt(text, offsetOf(text, at));
    if (!word) return null;
    const [first] = appearances(text, word.word);
    return { uri, range: rangeOf(text, first, first + word.word.length) };
  },
  "textDocument/references": ({ textDocument: { uri }, position: at }) => {
    const text = documents.get(uri);
    const word = wordAt(text, offsetOf(text, at));
    if (!word) return [];
    return appearances(text, word.word).map((from) => ({
      uri,
      range: rangeOf(text, from, from + word.word.length),
    }));
  },
  "textDocument/rename": ({ textDocument: { uri }, position: at, newName }) => {
    const text = documents.get(uri);
    const word = wordAt(text, offsetOf(text, at));
    if (!word) return null;
    return {
      changes: {
        [uri]: appearances(text, word.word).map((from) => ({
          range: rangeOf(text, from, from + word.word.length),
          newText: newName,
        })),
      },
    };
  },
  "textDocument/completion": ({ textDocument: { uri }, position: at }) => {
    const text = documents.get(uri);
    const offset = offsetOf(text, at);
    const typing = wordAt(text, offset);
    const prefix = typing ? text.slice(typing.from, offset) : "";
    const words = new Set(text.match(/[A-Za-z_]\w{2,}/g) ?? []);
    return [...words]
      .filter((word) => word.startsWith(prefix) && word !== prefix)
      .sort()
      .map((label) => ({ label, kind: 6 }));
  },
  "textDocument/hover": ({ textDocument: { uri }, position: at }) => {
    const text = documents.get(uri);
    const word = wordAt(text, offsetOf(text, at));
    return word
      ? {
          contents: {
            kind: "markdown",
            value: `\`\`\`python\n${word.word}: str\n\`\`\`\nAll about **${word.word}**.`,
          },
        }
      : null;
  },
  "textDocument/codeAction": ({ textDocument: { uri }, range }) => {
    const text = documents.get(uri);
    const from = offsetOf(text, range.start);
    const to = offsetOf(text, range.end);
    const oops = appearances(text, "oops").find((at) => at <= to && at + 4 >= from);
    if (oops === undefined) return [];
    const where = rangeOf(text, oops, oops + 4);
    return [
      { title: "Remove oops", kind: "quickfix", data: { uri, range: where } },
      {
        title: "Shout oops",
        kind: "refactor.rewrite",
        edit: { changes: { [uri]: [{ range: where, newText: "OOPS" }] } },
      },
      { title: "Explain oops", kind: "refactor", disabled: { reason: "Nothing can explain it" } },
    ];
  },
  "codeAction/resolve": (action) => ({
    ...action,
    edit: { changes: { [action.data.uri]: [{ range: action.data.range, newText: "" }] } },
  }),
};

const notifications = {
  "textDocument/didOpen": ({ textDocument }) => {
    documents.set(textDocument.uri, textDocument.text);
    diagnose(textDocument.uri);
  },
  "textDocument/didChange": ({ textDocument, contentChanges }) => {
    documents.set(textDocument.uri, contentChanges.at(-1).text);
    diagnose(textDocument.uri);
  },
  "textDocument/didClose": ({ textDocument }) => documents.delete(textDocument.uri),
  exit: () => process.exit(0),
};

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const length = Number(
      /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1],
    );
    if (!Number.isFinite(length)) throw new Error("a message came without its length");
    if (buffer.length < headerEnd + 4 + length) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
    buffer = buffer.subarray(headerEnd + 4 + length);
    if (message.id !== undefined && message.method) {
      const handler = handlers[message.method];
      if (handler) send({ id: message.id, result: handler(message.params) });
      else send({ id: message.id, error: { code: -32601, message: `no ${message.method}` } });
    } else if (message.method) {
      notifications[message.method]?.(message.params);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
