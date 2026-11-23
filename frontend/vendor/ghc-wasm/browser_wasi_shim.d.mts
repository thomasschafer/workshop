export class File {
  data: Uint8Array;
  constructor(data: Uint8Array, options?: { readonly?: boolean });
}
export class OpenFile {
  constructor(file: File);
}
export class Directory {
  contents: Map<string, File | Directory>;
  constructor(entries: Iterable<[string, File | Directory]>);
}
export class PreopenDirectory {
  dir: Directory;
  constructor(path: string, entries: Iterable<[string, File | Directory]>);
}
export class ConsoleStdout {
  constructor(write: (buf: Uint8Array) => void);
  static lineBuffered(write: (line: string) => void): ConsoleStdout;
}
export class WASI {
  fds: unknown[];
  wasiImport: WebAssembly.ModuleImports;
  constructor(args: string[], env: string[], fds: unknown[], options?: { debug?: boolean });
  start(instance: WebAssembly.Instance): number;
}
