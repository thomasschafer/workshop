import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setWasmBytesLoader } from "./languages";

/**
 * Installs a Node filesystem loader for Vite `?url` `.wasm` assets so Vitest tests can load
 * vendored tree-sitter grammars without a browser or HTTP server.
 */
export function installNodeWasmLoader(): void {
  setWasmBytesLoader(async (url) => {
    let filePath = url;
    if (filePath.startsWith("file://")) {
      filePath = fileURLToPath(filePath);
    } else if (filePath.startsWith("/@fs/")) {
      filePath = filePath.slice("/@fs".length);
    } else if (filePath.startsWith("/")) {
      filePath = resolve(process.cwd(), filePath.slice(1));
    }
    const buf = await readFile(filePath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });
}
