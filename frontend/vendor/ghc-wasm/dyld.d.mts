import type { PreopenDirectory } from "./browser_wasi_shim.mjs";

export class DyLDBrowserHost {
  constructor(options: {
    rootfs?: PreopenDirectory;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    stdoutChunk?: (buf: Uint8Array) => void;
    stderrChunk?: (buf: Uint8Array) => void;
  });
}

export interface DyLDInstance {
  exportFuncs: {
    myMain: (libdir: string) => Promise<(ghcArgs: string, code: string) => Promise<void>>;
  };
  readonly wasmMemoryBytes: number;
  setStdin: (bytes: Uint8Array) => void;
}

export function main(options: {
  rpc: DyLDBrowserHost;
  searchDirs: string[];
  mainSoPath: string;
  args: string[];
  isIserv: boolean;
}): Promise<DyLDInstance>;
