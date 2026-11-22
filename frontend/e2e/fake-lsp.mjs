// A stand-in for a language server, so the browser tests need none installed. It knows nothing
// of Python: it works on words. Every `oops` in the file is an error, with a message of several
// lines, and every `hmm` a warning. A word's definition is its first appearance, its references
// are all of them, and renaming it changes each. It completes a word to the file's other words. Over an `oops`, it offers to remove it, sending
// the edit only once that's chosen, and to shout it, with the edit straight away. Its hover
// documentation says which process it is, to tell one server from another.
//
// It also completes three names that need importing, each imported the way one kind of server
// does it: `fetchByCommand` with a command it runs to ask the client to add the import, as the
// Haskell language server does; `fetchOnResolve` with the import given only once it's asked for
// the completion in full; and `fetchSnippet`, a snippet sent with its import. Each says, beside
// its label, the module it's imported from.
//
// It formats by squeezing runs of spaces within a line to one and dropping spaces at the ends of
// lines, sending the whole file back as one edit, as some servers do. It can't format a file with
// `unparsable` in it, and says so as the Haskell language server does, with a message to show as
// well as in answer. A change that adds an `alarm` to the file has it report an error of its own.
//
// Started where there's a file named `fake-lsp-fails`, it fails as it starts, saying why on
// stderr, as a server missing something it needs would.

import { existsSync } from "node:fs";

// As FAKE_LSP_FAILS in fixture.ts.
if (existsSync("fake-lsp-fails")) {
  process.stderr.write("fake-lsp: told to fail as it starts\n");
  process.exit(1);
}

const documents = new Map();
let nextRequest = 0;

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

/** Reports an error of the server's own if `text` has an `alarm` that `before` didn't. */
function raiseAlarm(before, text) {
  if (appearances(text, "alarm").length > appearances(before, "alarm").length) {
    send({
      method: "window/showMessage",
      params: { type: 1, message: `server ${process.pid} raised the alarm` },
    });
  }
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

/** An edit adding an import of `name` at the top of the file. */
const importOf = (name) => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  newText: `from fake import ${name}\n`,
});

const handlers = {
  initialize: () => ({
    capabilities: {
      textDocumentSync: 1,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: true,
      hoverProvider: true,
      codeActionProvider: { resolveProvider: true },
      completionProvider: { resolveProvider: true },
      documentFormattingProvider: true,
      executeCommandProvider: { commands: ["fake.import"] },
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
    // A name the server won't take, for refusing a rename as real servers can.
    if (newName === "print") throw new Error("print is already taken");
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
    const imported = [
      {
        label: "fetchByCommand",
        labelDetails: { description: "fake" },
        kind: 3,
        command: {
          title: "import",
          command: "fake.import",
          arguments: [{ uri, name: "fetchByCommand" }],
        },
      },
      {
        label: "fetchOnResolve",
        labelDetails: { description: "fake" },
        kind: 3,
        data: { uri, name: "fetchOnResolve" },
      },
      {
        label: "fetchSnippet",
        labelDetails: { description: "fake" },
        kind: 3,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a snippet, not a template
        insertText: "fetchSnippet(${1:url})",
        insertTextFormat: 2,
        additionalTextEdits: [importOf("fetchSnippet")],
      },
    ];
    return [
      ...[...words]
        .filter((word) => word.startsWith(prefix) && word !== prefix)
        .sort()
        .map((label) => ({ label, kind: 6 })),
      ...(prefix === "" ? [] : imported.filter(({ label }) => label.startsWith(prefix))),
    ];
  },
  "textDocument/formatting": ({ textDocument: { uri } }) => {
    const text = documents.get(uri);
    if (appearances(text, "unparsable").length > 0) {
      const failed = "couldn't parse the file to format it";
      send({
        method: "window/showMessage",
        params: { type: 1, message: `Error condition: ${failed}` },
      });
      throw new Error(failed);
    }
    const formatted = text
      .split("\n")
      .map((line) => {
        const indent = /^ */.exec(line)[0];
        return indent + line.slice(indent.length).replace(/ {2,}/g, " ").trimEnd();
      })
      .join("\n");
    return [{ range: rangeOf(text, 0, text.length), newText: formatted }];
  },
  "completionItem/resolve": (item) =>
    item.data ? { ...item, additionalTextEdits: [importOf(item.data.name)] } : item,
  "workspace/executeCommand": ({ command, arguments: [{ uri, name }] }) => {
    if (command !== "fake.import") throw new Error(`no command ${command}`);
    send({
      id: `fake-${nextRequest++}`,
      method: "workspace/applyEdit",
      params: { edit: { changes: { [uri]: [importOf(name)] } } },
    });
    return null;
  },
  "textDocument/hover": ({ textDocument: { uri }, position: at }) => {
    const text = documents.get(uri);
    const word = wordAt(text, offsetOf(text, at));
    return word
      ? {
          contents: {
            kind: "markdown",
            value: `\`\`\`python\n${word.word}: str\n\`\`\`\nAll about **${word.word}**, from server ${process.pid}.`,
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
    raiseAlarm("", textDocument.text);
    diagnose(textDocument.uri);
  },
  "textDocument/didChange": ({ textDocument, contentChanges }) => {
    const text = contentChanges.at(-1).text;
    raiseAlarm(documents.get(textDocument.uri), text);
    documents.set(textDocument.uri, text);
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
      if (!handler) {
        send({ id: message.id, error: { code: -32601, message: `no ${message.method}` } });
        continue;
      }
      try {
        send({ id: message.id, result: handler(message.params) });
      } catch (error) {
        send({ id: message.id, error: { code: -32603, message: error.message } });
      }
    } else if (message.method) {
      notifications[message.method]?.(message.params);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
