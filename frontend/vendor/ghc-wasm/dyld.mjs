// Note [The Wasm Dynamic Linker]
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
//
// This script mainly has two roles:
//
// 1. Message broker: relay iserv messages between host GHC and wasm
//    iserv (GHCi.Server.defaultServer). This part only runs in
//    nodejs.
// 2. Dynamic linker: provide RTS linker interfaces like
//    loadDLLs/lookupSymbol etc which are imported by wasm iserv. This
//    part can run in browsers as well.
//
// When GHC starts external interpreter for the wasm target, it starts
// this script and passes a pair of pipe fds for iserv messages,
// libHSghci.so path, and command line arguments for wasm iserv. By
// default, the wasm iserv runs in the same node process, so the
// message broker logic is simple: wrap the pipe fds as
// ReadableStream/WritableStream, pass reader/writer callbacks to wasm
// iserv and run it to completion. It doesn't need to intercept or
// parse any message, unlike iserv-proxy.
//
// Things are a bit more interesting with ghci browser mode. All the
// Haskell code and all the runtime runs in the browser, including the
// dynamic linker parts of this script. The host GHC process doeesn't
// need to know about "browser mode" at all as long as iserv messages
// are handled as usual, though obviously we can't pass fds to
// browsers like before! So this script starts an HTTP 1.1 server with
// WebSockets support. The browser side can import a startup script
// served by the server, which will import this script and invoke main
// with the right arguments, hooray isomorphic JavaScript! The browser
// side will proceed to bootstrap wasm iserv, and the iserv messages
// are relayed over the WebSockets. (also ^C signals over a different
// connection)
//
// Under the browser mode, there's more traffic than just the iserv
// message WebSockets. The browser side can fulfill most of the RTS
// linker functionality alone, but it still needs to do stuff like
// searching for a shared library in a bunch of search paths or
// fetching a shared library blob; these side effects require access
// to the same host filesystem that runs GHC, so the HTTP server also
// exposes some rpc endpoints that the browser side can perform
// requests. The server binds to 127.0.0.1 by default for a good
// reason, it doesn't (and shouldn't) have extra logic to try to guard
// against potential malicious requests to scrape your home directory.
//
// So much intro to the message broker part, below are Q/As regarding
// the dynamic linker part:
//
// *** What works right now and what doesn't work yet?
//
// loadDLLs & bytecode interpreter work. Template Haskell & ghci work.
// Profiled dynamic code works. Compiled code and bytecode can all be
// loaded, though the side effects are constrained to what's supported
// by wasi preview1: we map the full host filesystem into wasm cause
// yolo, but things like processes and sockets don't work.
//
// loadArchive/loadObj etc are unsupported and will stay that way. The
// only form of compiled code that can be loaded is wasm shared
// library. There's no code unloading logic. The retain_cafs flag is
// ignored and revertCAFs is a no-op.
//
// JSFFI works. ghci debugger works.
//
// *** What are implications to end users?
//
// Even if you intend to compile fully static wasm modules, you must
// compile everything with -dynamic-too to ensure shared libraries are
// present, otherwise TH doesn't work. In cabal, this is achieved by
// setting `shared: True` in the global cabal config (or under a
// `package *` stanza in your `cabal.project`). You also need to set
// `library-for-ghci: False` since that's unsupported.
//
// *** Why not extend the RTS linker in C like every other new
// platform?
//
// Aside from all the pain of binary manipulation in C, what you can
// do in C on wasm is fairly limited: for instance, you can't manage
// executable memory regions at all. So you need a lot of back and
// forth between C and JS host, totally not worth the extra effort
// just for the sake of making the original C RTS linker interface
// partially work.
//
// *** What kind of wasm shared library can be loaded? What features
// work to what extent?
//
// We support .so files produced by wasm-ld --shared which conforms to
// https://github.com/WebAssembly/tool-conventions/blob/f44d6c526a06a19eec59003a924e475f57f5a6a1/DynamicLinking.md.
// All .so files in the wasm32-wasi sysroot as well as those produced
// by ghc can be loaded.
//
// For simplicity, we don't have any special treatment for weak
// symbols. Any unresolved symbol at link-time will not produce an
// error, they will only trigger an error when they're used at
// run-time and the data/function definition has not been realized by
// then.
//
// There's no dlopen/dlclose etc exposed to the C/C++ world, the
// interfaces here are directly called by JSFFI imports in ghci.
// There's no so unloading logic yet, but it would be fairly easy to
// add once we need it.
//
// No fancy stuff like LD_PRELOAD, LD_LIBRARY_PATH etc.

import * as wasi from "./browser_wasi_shim.mjs";
import { JSValManager, setImmediate } from "./prelude.mjs";
import { parseRecord, parseSections } from "./post-link.mjs";

// Make a consumer callback from a buffer. See Parser class
// constructor comments for what a consumer is.
function makeBufferConsumer(buf) {
  return (len) => {
    if (len > buf.length) {
      throw new Error("not enough bytes");
    }

    const r = buf.subarray(0, len);
    buf = buf.subarray(len);
    return r;
  };
}

// Make a consumer callback from a ReadableStreamDefaultReader.
function makeStreamConsumer(reader) {
  let buf = new Uint8Array();

  return async (len) => {
    while (buf.length < len) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("not enough bytes");
      }
      if (buf.length === 0) {
        buf = value;
        continue;
      }
      const tmp = new Uint8Array(buf.length + value.length);
      tmp.set(buf, 0);
      tmp.set(value, buf.length);
      buf = tmp;
    }

    const r = buf.subarray(0, len);
    buf = buf.subarray(len);
    return r;
  };
}

// A simple binary parser
class Parser {
  #cb;
  #consumed = 0;
  #limit;

  // cb is a consumer callback that returns a buffer with exact N
  // bytes for await cb(N). limit indicates how many bytes the Parser
  // may consume at most; it's optional and only used by eof().
  constructor(cb, limit) {
    this.#cb = cb;
    this.#limit = limit;
  }

  eof() {
    return this.#consumed >= this.#limit;
  }

  async skip(len) {
    await this.#cb(len);
    this.#consumed += len;
  }

  async readUInt8() {
    const r = (await this.#cb(1))[0];
    this.#consumed += 1;
    return r;
  }

  async readULEB128() {
    let acc = 0n,
      shift = 0n;
    while (true) {
      const byte = await this.readUInt8();
      acc |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if (byte >> 7 === 0) {
        break;
      }
    }
    return Number(acc);
  }

  async readBuffer() {
    const len = await this.readULEB128();
    const r = await this.#cb(len);
    this.#consumed += len;
    return r;
  }

  async readString() {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.readBuffer()
    );
  }
}

// Parse the dylink.0 section of a wasm module
async function parseDyLink0(reader) {
  const p0 = new Parser(makeStreamConsumer(reader));
  // magic, version
  await p0.skip(8);
  // section id
  console.assert((await p0.readUInt8()) === 0);
  const p1_buf = await p0.readBuffer();
  const p1 = new Parser(makeBufferConsumer(p1_buf), p1_buf.length);
  // custom section name
  console.assert((await p1.readString()) === "dylink.0");

  const r = { neededSos: [], exportInfo: [], importInfo: [] };
  while (!p1.eof()) {
    const subsection_type = await p1.readUInt8();
    const p2_buf = await p1.readBuffer();
    const p2 = new Parser(makeBufferConsumer(p2_buf), p2_buf.length);
    switch (subsection_type) {
      case 1: {
        // WASM_DYLINK_MEM_INFO
        r.memSize = await p2.readULEB128();
        r.memP2Align = await p2.readULEB128();
        r.tableSize = await p2.readULEB128();
        r.tableP2Align = await p2.readULEB128();
        break;
      }
      case 2: {
        // WASM_DYLINK_NEEDED
        //
        // There may be duplicate entries. Not a big deal to not
        // dedupe, but why not.
        const n = await p2.readULEB128();
        const acc = new Set();
        for (let i = 0; i < n; ++i) {
          acc.add(await p2.readString());
        }
        r.neededSos = [...acc];
        break;
      }
      case 3: {
        // WASM_DYLINK_EXPORT_INFO
        //
        // Not actually used yet, kept for completeness in case of
        // future usage.
        const n = await p2.readULEB128();
        for (let i = 0; i < n; ++i) {
          const name = await p2.readString();
          const flags = await p2.readULEB128();
          r.exportInfo.push({ name, flags });
        }
        break;
      }
      case 4: {
        // WASM_DYLINK_IMPORT_INFO
        //
        // Same.
        const n = await p2.readULEB128();
        for (let i = 0; i < n; ++i) {
          const module = await p2.readString();
          const name = await p2.readString();
          const flags = await p2.readULEB128();
          r.importInfo.push({ module, name, flags });
        }
        break;
      }
      default: {
        throw new Error(`unknown subsection type ${subsection_type}`);
      }
    }
  }

  return r;
}

// Formats a server.address() result to a URL origin with correct
// handling for IPv6 hostname
function originFromServerAddress({ address, family, port }) {
  const hostname = family === "IPv6" ? `[${address}]` : address;
  return `http://${hostname}:${port}`;
}

function normalizePosixPath(p) {
  const parts = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return "/" + parts.join("/");
}

// Runs in the browser (or WASI shim) using the in-memory VFS.
export class DyLDBrowserHost {
  #rpaths = new Set();
  rootfs;
  stdout;
  stderr;
  stdoutChunk;
  stderrChunk;

  #readFile(p) {
    const normalized = normalizePosixPath(p);
    const { ret, entry } = this.rootfs.dir.get_entry_for_path({
      parts: normalized.split("/").filter((tok) => tok !== ""),
      is_dir: false,
    });
    return ret === 0 ? entry : null;
  }

  #resolvePath(p) {
    const normalized = normalizePosixPath(p);
    if (this.#readFile(normalized)) {
      return normalized;
    }
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    if (base) {
      const names = base.startsWith("liblib") ? [base, base.slice(3)] : [base];
      for (const name of names) {
        for (const rpath of this.#rpaths) {
          const candidate = normalizePosixPath(`${rpath}/${name}`);
          if (this.#readFile(candidate)) {
            return candidate;
          }
        }
      }
    }
    return null;
  }

  constructor({ rootfs, stdout, stderr, stdoutChunk, stderrChunk }) {
    this.rootfs = rootfs
      ? rootfs
      : new wasi.PreopenDirectory("/", [["tmp", new wasi.Directory([])]]);
    this.stdout = stdout ? stdout : (msg) => console.info(msg);
    this.stderr = stderr ? stderr : (msg) => console.warn(msg);
    this.stdoutChunk = stdoutChunk || null;
    this.stderrChunk = stderrChunk || null;
  }

  async addLibrarySearchPath(p) {
    this.#rpaths.add(normalizePosixPath(p));
    return null;
  }

  async findSystemLibrary(f) {
    const resolved = f.startsWith("/") ? this.#resolvePath(f) : this.#resolvePath(f);
    if (resolved) {
      return resolved;
    }
    throw new Error(`findSystemLibrary(${f}): not found in ${[...this.#rpaths]}`);
  }

  async fetchWasm(p) {
    const resolved = this.#resolvePath(p);
    const entry = resolved ? this.#readFile(resolved) : null;
    if (!entry || !entry.data) {
      throw new Error(`fetchWasm(${p}): not found in VFS or ${[...this.#rpaths]}`);
    }
    const r = new Response(entry.data, {
      headers: { "Content-Type": "application/wasm" },
    });
    // Prune after loading to save linear VFS memory.
    entry.data = new Uint8Array();
    return r;
  }
}

// The real stuff
class DyLD {
  // Wasm page size.
  static #pageSize = 0x10000;

  // Placeholder value of GOT.mem addresses that must be imported
  // first and later modified to be the correct relocated pointer.
  // This value is 0xffffffff subtracts one page, so hopefully any
  // memory access near this address will trap immediately.
  //
  // In JS API i32 is signed, hence this layer of redirection.
  static #poison = (0xffffffff - DyLD.#pageSize) | 0;

  // When processing exports, skip the following ones since they're
  // generated by wasm-ld.
  static #ldGeneratedExportNames = new Set([
    "_initialize",
    "__wasm_apply_data_relocs",
    "__wasm_apply_global_relocs",
    "__wasm_call_ctors",
  ]);

  // Handles RPC logic back to host in a browser, or just do plain
  // function calls in node
  #rpc;

  // The WASI instance to provide wasi imports, shared across all wasm
  // instances
  #wasi;

  // Wasm memory & table
  #memory = new WebAssembly.Memory({ initial: 1 });

  #table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  // First free slot, might be invalid when it advances to #table.length
  #tableFree = 1;
  // See Note [The evil wasm table grower]
  #tableGrowInstance = new WebAssembly.Instance(
    new WebAssembly.Module(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 127, 1, 127, 2, 35, 1, 3,
        101, 110, 118, 25, 95, 95, 105, 110, 100, 105, 114, 101, 99, 116, 95,
        102, 117, 110, 99, 116, 105, 111, 110, 95, 116, 97, 98, 108, 101, 1,
        112, 0, 0, 3, 2, 1, 0, 7, 31, 1, 27, 95, 95, 103, 104, 99, 95, 119, 97,
        115, 109, 95, 106, 115, 102, 102, 105, 95, 116, 97, 98, 108, 101, 95,
        103, 114, 111, 119, 0, 0, 10, 11, 1, 9, 0, 208, 112, 32, 0, 252, 15, 0,
        11,
      ])
    ),
    { env: { __indirect_function_table: this.#table } }
  );

  // __stack_pointer
  #sp = new WebAssembly.Global(
    {
      value: "i32",
      mutable: true,
    },
    DyLD.#pageSize
  );

  // The JSVal manager
  #jsvalManager = new JSValManager();

  // sonames of loaded sos.
  //
  // Note that "soname" is just xxx.so as in file path, not actually
  // parsed from a section in .so file. wasm-ld does accept
  // --soname=<value>, but it just writes the module name to the name
  // section, which can be stripped by wasm-opt and such. We do not
  // rely on the name section at all.
  //
  // Invariant: soname is globally unique!
  #loadedSos = new Set();

  // Mapping from export names to export funcs. It's also passed as
  // __exports in JSFFI code, hence the "memory" special field.
  exportFuncs = { memory: this.#memory };

  // The FinalizationRegistry used by JSFFI.
  #finalizationRegistry = new FinalizationRegistry((sp) =>
    this.exportFuncs.rts_freeStablePtr(sp)
  );

  // The GOT.func table.
  #gotFunc = {};

  // The GOT.mem table. By wasm dylink convention, a wasm global
  // exported by .so is always assumed to be a GOT.mem entry, not a
  // re-exported actual wasm global.
  #gotMem = {};

  // Global STG registers
  #regs = {};

  // Note [The evil wasm table grower]
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  // We need to grow the wasm table as we load shared libraries in
  // wasm dyld. We used to directly call the table.grow() JS API,
  // which works as expected in Firefox/Chrome, but unfortunately,
  // WebKit's implementation of the table.grow() JS API is broken:
  // https://bugs.webkit.org/show_bug.cgi?id=290681, which means that
  // the wasm dyld simply does not work in WebKit-based browsers like
  // Safari.
  //
  // Now, one simple workaround would be to avoid growing the table at
  // all: just allocate a huge table upfront (current limitation
  // agreed by all vendors is 10000000). To avoid unnecessary space
  // waste on non-WebKit platforms, we could additionally check
  // navigator.userAgent against some regexes and only allocate
  // fixed-length table when there's no blink/gecko mention. But this
  // is fragile and gross, and it's better to stick to a uniform code
  // path for all browsers.
  //
  // Fortunately, it turns out the table.grow wasm instruction work as
  // expected in WebKit! So we can invoke a wasm function that grows
  // the table for us. But don't open a champagne yet, where would
  // that wasm function come from? It can't be put into RTS, or even
  // libc.so, because loading those libraries would require growing
  // the table in the first place! Or perhaps, reserve a table upfront
  // that's just large enough to load RTS and then we can access that
  // function for subsequent table grows? But then we need to
  // experiment for a reasonable initial size, and add a magic number
  // here, which is also fragile and gross and not future-proof!
  //
  // So this special wasm function needs to live in a single wasm
  // module, which is loaded before we load anything else. The full
  // source code for this module is:
  //
  // (module
  //   (type (func (param i32) (result i32)))
  //   (import "env" "__indirect_function_table" (table 0 funcref))
  //   (export "__ghc_wasm_jsffi_table_grow" (func 0))
  //   (func (type 0) (param i32) (result i32)
  //     ref.null func
  //     local.get 0
  //     table.grow 0
  //   )
  // )
  //
  // This module is 103 bytes so that we can inline its blob in dyld,
  // and use the usually discouraged synchronous
  // WebAssembly.Instance/WebAssembly.Module constructors to load it.
  // On non-WebKit platforms, growing tables this way would introduce
  // a bit of extra JS/Wasm interop overhead, which can be amplified
  // as we used to call table.grow(1, foo) for every GOT.func item.
  // Therefore, unless we're about to exceed the hard limit of table
  // size, we now grow the table exponentially, and use bump
  // allocation to calculate the table index to be returned.
  // Exponential growth is only implemented to minimize the JS/Wasm
  // interop overhead when calling __ghc_wasm_jsffi_table_grow;
  // V8/SpiderMonkey/WebKit already do their own exponential growth of
  // the table's backing buffer in their table growth logic.
  //
  // Invariants: n >= 0; when v is non-null, n === 1
  #tableGrow(n, v) {
    const prev_free = this.#tableFree;
    if (prev_free + n > this.#table.length) {
      const min_delta = prev_free + n - this.#table.length;
      const delta = Math.max(min_delta, this.#table.length);
      this.#tableGrowInstance.exports.__ghc_wasm_jsffi_table_grow(
        this.#table.length + delta <= 10000000 ? delta : min_delta
      );
    }
    if (v) {
      this.#table.set(prev_free, v);
    }
    this.#tableFree += n;
    return prev_free;
  }

  constructor({ args, rpc }) {
    this.#rpc = rpc;

    const stdoutFd = this.#rpc.stdoutChunk
      ? new wasi.ConsoleStdout((buf) => this.#rpc.stdoutChunk(buf))
      : wasi.ConsoleStdout.lineBuffered((msg) => this.#rpc.stdout(msg));
    const stderrFd = this.#rpc.stderrChunk
      ? new wasi.ConsoleStdout((buf) => this.#rpc.stderrChunk(buf))
      : wasi.ConsoleStdout.lineBuffered((msg) => this.#rpc.stderr(msg));
    this.#wasi = new wasi.WASI(
      args,
      [],
      [
        new wasi.OpenFile(
          new wasi.File(new Uint8Array(), { readonly: true })
        ),
        stdoutFd,
        stderrFd,
        this.#rpc instanceof DyLDBrowserHost
          ? this.#rpc.rootfs
          : new wasi.PreopenDirectory("/", [["tmp", new wasi.Directory([])]]),
      ],
      { debug: false }
    );
    // Keep standard streams (fds 0, 1, 2) reserved across repeated runs in the
    // same GHC RTS so closing stdin after lazy getContents never recycles fd 0.
    const origFdClose = this.#wasi.wasiImport.fd_close;
    this.#wasi.wasiImport.fd_close = (fd) => {
      if (fd === 0 || fd === 1 || fd === 2) {
        return 0;
      }
      return origFdClose(fd);
    };

    // Both wasi implementations we use provide
    // wasi.initialize(instance) to initialize a wasip1 reactor
    // module. However, instance does not really need to be a
    // WebAssembly.Instance object; the wasi implementations only need
    // to access instance.exports.memory for the wasi syscalls to
    // work.
    //
    // Given we'll reuse the same wasi object across different
    // WebAssembly.Instance objects anyway and
    // wasi.initialize(instance) can't be called more than once, we
    // use this simple trick and pass a fake instance object that
    // contains just enough info for the wasi implementation to
    // initialize its internal state. Later when we load each wasm
    // shared library, we can just manually invoke their
    // initialization functions.
    this.#wasi.initialize({
      exports: {
        memory: this.#memory,
      },
    });

    // Keep this in sync with rts/wasm/Wasm.S!
    for (let i = 1; i <= 10; ++i) {
      this.#regs[`__R${i}`] = new WebAssembly.Global({
        value: "i32",
        mutable: true,
      });
    }

    for (let i = 1; i <= 6; ++i) {
      this.#regs[`__F${i}`] = new WebAssembly.Global({
        value: "f32",
        mutable: true,
      });
    }

    for (let i = 1; i <= 6; ++i) {
      this.#regs[`__D${i}`] = new WebAssembly.Global({
        value: "f64",
        mutable: true,
      });
    }

    this.#regs.__L1 = new WebAssembly.Global({ value: "i64", mutable: true });

    for (const k of ["__Sp", "__SpLim", "__Hp", "__HpLim"]) {
      this.#regs[k] = new WebAssembly.Global({ value: "i32", mutable: true });
    }
  }

  async addLibrarySearchPath(p) {
    return this.#rpc.addLibrarySearchPath(p);
  }

  async findSystemLibrary(f) {
    return this.#rpc.findSystemLibrary(f);
  }

  // When we do loadDLLs, we first perform "downsweep" which return a
  // toposorted array of dependencies up to itself, then sequentially
  // load the downsweep result.
  //
  // The rationale of a separate downsweep phase, instead of a simple
  // recursive loadDLLs function is: V8 delegates async
  // WebAssembly.compile to a background worker thread pool. To
  // maintain consistent internal linker state, we *must* load each so
  // file sequentially, but it's okay to kick off compilation asap,
  // store the Promise in downsweep result and await for the actual
  // WebAssembly.Module in loadDLLs logic. This way we can harness some
  // background parallelism.
  async #downsweep(p) {
    const toks = p.split("/");

    const rawSoname = toks[toks.length - 1];
    const soname = rawSoname.startsWith("liblib") ? rawSoname.slice(3) : rawSoname;

    if (this.#loadedSos.has(soname)) {
      return [];
    }

    // Do this before loading dependencies to break potential cycles.
    this.#loadedSos.add(soname);

    if (p.startsWith("/")) {
      // GHC may attempt to load libghc_tmp_2.so that needs
      // libghc_tmp_1.so in a temporary directory without adding that
      // directory via addLibrarySearchPath
      toks.pop();
      await this.addLibrarySearchPath(toks.join("/"));
    } else {
      p = await this.findSystemLibrary(p);
    }

    const resp = await this.#rpc.fetchWasm(p);
    const resp2 = resp.clone();
    const modp = WebAssembly.compileStreaming(resp);
    // Parse dylink.0 from the raw buffer, not via
    // WebAssembly.Module.customSections(). This should return asap
    // without waiting for rest of the wasm module binary data.
    const r = await parseDyLink0(resp2.body.getReader());
    r.modp = modp;
    r.soname = soname;
    let acc = [];
    for (const dep of r.neededSos) {
      acc.push(...(await this.#downsweep(dep)));
    }
    acc.push(r);
    return acc;
  }

  // Batch load multiple DLLs in one go.
  // Accepts a NUL-delimited string of paths to avoid array marshalling.
  // Each path can be absolute or a soname; dependency resolution is
  // performed across the full set to enable maximal parallel compile
  // while maintaining sequential instantiation order.
  async loadDLLs(packed) {
    // Normalize input to an array of strings. When called from Haskell
    // we pass a single JSString containing NUL-separated paths.
    const paths = (
      typeof packed === "string"
        ? packed.length === 0
          ? []
          : packed.split("\0")
        : [packed]
    ) // tolerate an accidental single path object
      .filter((s) => s.length > 0)
      .reverse();

    // Compute a single downsweep plan for the whole batch.
    // Note: #downsweep mutates #loadedSos to break cycles and dedup.
    const plan = [];
    for (const p of paths) {
      plan.push(...(await this.#downsweep(p)));
    }

    for (const {
      memSize,
      memP2Align,
      tableSize,
      tableP2Align,
      modp,
      soname,
    } of plan) {
      const import_obj = {
        wasi_snapshot_preview1: this.#wasi.wasiImport,
        env: {
          memory: this.#memory,
          __indirect_function_table: this.#table,
          __stack_pointer: this.#sp,
          ...this.exportFuncs,
        },
        regs: this.#regs,
        // Keep this in sync with post-link.mjs!
        ghc_wasm_jsffi: {
          newJSVal: (v) => this.#jsvalManager.newJSVal(v),
          getJSVal: (k) => this.#jsvalManager.getJSVal(k),
          freeJSVal: (k) => this.#jsvalManager.freeJSVal(k),
          scheduleWork: () => setImmediate(this.exportFuncs.rts_schedulerLoop),
        },
        "GOT.mem": this.#gotMem,
        "GOT.func": this.#gotFunc,
      };

      // __memory_base & __table_base, different for each .so
      let memory_base;
      let table_base = this.#tableGrow(tableSize);
      console.assert(tableP2Align === 0);

      // libc.so is always the first one to be ever loaded and has VIP
      // treatment. It will never be unloaded even if we support
      // unloading in the future. Nor do we support multiple libc.so
      // in the same address space.
      if (soname === "libc.so") {
        // Starting from 0x0: one page of C stack, then global data
        // segments of libc.so, then one page space between
        // __heap_base/__heap_end so that dlmalloc can initialize
        // global state. wasm-ld aligns __heap_base to page sized so
        // we follow suit.
        console.assert(memP2Align <= Math.log2(DyLD.#pageSize));
        memory_base = DyLD.#pageSize;
        const data_pages = Math.ceil(memSize / DyLD.#pageSize);
        this.#memory.grow(data_pages + 1);

        this.#gotMem.__heap_base = new WebAssembly.Global(
          { value: "i32", mutable: true },
          DyLD.#pageSize * (1 + data_pages)
        );
        this.#gotMem.__heap_end = new WebAssembly.Global(
          { value: "i32", mutable: true },
          DyLD.#pageSize * (1 + data_pages + 1)
        );
      } else {
        // TODO: this would also be __dso_handle@GOT, in case we
        // implement so unloading logic in the future.
        memory_base = this.exportFuncs.aligned_alloc(1 << memP2Align, memSize);
      }

      import_obj.env.__memory_base = new WebAssembly.Global(
        { value: "i32", mutable: false },
        memory_base
      );
      import_obj.env.__table_base = new WebAssembly.Global(
        { value: "i32", mutable: false },
        table_base
      );

      const mod = await modp;

      // Fulfill the ghc_wasm_jsffi imports. Use new Function()
      // instead of eval() to prevent bindings in this local scope to
      // be accessed by JSFFI code snippets. See Note [Variable passing in JSFFI]
      // for what's going on here.
      Object.assign(
        import_obj.ghc_wasm_jsffi,
        new Function(
          "__exports",
          "__ghc_wasm_jsffi_dyld",
          "__ghc_wasm_jsffi_finalization_registry",
          "return {".concat(
            ...parseSections(mod).map(
              (rec) => `${rec[0]}: ${parseRecord(rec)}, `
            ),
            "};"
          )
        )(this.exportFuncs, this, this.#finalizationRegistry)
      );

      // Fulfill the rest of the imports
      for (const { module, name, kind } of WebAssembly.Module.imports(mod)) {
        // Already there, no handling required
        if (import_obj[module] && import_obj[module][name]) {
          continue;
        }

        // Add a lazy function stub in env, but don't put it into
        // exportFuncs yet. This lazy binding is only effective for
        // the current so, since env is a transient object created on
        // the fly.
        if (module === "env" && kind === "function") {
          import_obj.env[name] = (...args) => {
            if (!this.exportFuncs[name]) {
              throw new WebAssembly.RuntimeError(
                `non-existent function ${name}`
              );
            }
            return this.exportFuncs[name](...args);
          };
          continue;
        }

        // Add a lazy GOT.mem entry with poison value, in the hope
        // that if they're used before being resolved with real
        // addresses, a memory trap will be triggered immediately.
        if (module === "GOT.mem" && kind === "global") {
          this.#gotMem[name] = new WebAssembly.Global(
            { value: "i32", mutable: true },
            DyLD.#poison
          );
          continue;
        }

        // Missing entry in GOT.func table, could be already defined
        // or not
        if (module === "GOT.func" && kind === "global") {
          // A dependency has exported the function, just create the
          // entry on the fly
          if (this.exportFuncs[name]) {
            this.#gotFunc[name] = new WebAssembly.Global(
              { value: "i32", mutable: true },
              this.#tableGrow(1, this.exportFuncs[name])
            );
            continue;
          }

          // Can't find this function, so poison it like GOT.mem.
          // TODO: when wasm type reflection is widely available in
          // browsers, use the WebAssembly.Function constructor to
          // dynamically create a stub function that does better error
          // reporting
          this.#gotFunc[name] = new WebAssembly.Global(
            { value: "i32", mutable: true },
            DyLD.#poison
          );
          continue;
        }

        throw new Error(
          `cannot handle import ${module}.${name} with kind ${kind}`
        );
      }

      // Fingers crossed...
      const instance = await WebAssembly.instantiate(mod, import_obj);

      // Process the exports
      for (const k in instance.exports) {
        // Boring stuff
        if (DyLD.#ldGeneratedExportNames.has(k)) {
          continue;
        }

        // Invariant: each function symbol can be defined only once.
        // This is incorrect for weak symbols which are allowed to
        // appear multiple times but this is sufficient in practice.
        console.assert(
          !this.exportFuncs[k],
          `duplicate symbol ${k} when loading ${soname}`
        );

        const v = instance.exports[k];

        if (typeof v === "function") {
          this.exportFuncs[k] = v;
          // If there's a lazy GOT.func entry, put the function in the
          // table and fulfill the entry. Otherwise no need to do
          // anything, if it's required later a GOT.func entry will be
          // created on demand.
          if (this.#gotFunc[k]) {
            const got = this.#gotFunc[k];
            if (got.value === DyLD.#poison) {
              const idx = this.#tableGrow(1, v);
              got.value = idx;
            } else {
              this.#table.set(got.value, v);
            }
          }
          continue;
        }

        // It's a GOT.mem entry
        if (v instanceof WebAssembly.Global) {
          const addr = v.value + memory_base;
          if (this.#gotMem[k]) {
            console.assert(this.#gotMem[k].value === DyLD.#poison);
            this.#gotMem[k].value = addr;
          } else {
            this.#gotMem[k] = new WebAssembly.Global(
              { value: "i32", mutable: true },
              addr
            );
          }
          continue;
        }

        throw new Error(`cannot handle export ${k} ${v}`);
      }

      // See
      // https://gitlab.haskell.org/haskell-wasm/llvm-project/-/blob/release/21.x/lld/wasm/Writer.cpp#L1451,
      // __wasm_apply_data_relocs is now optional so only call it if
      // it exists (we know for sure it exists for libc.so though).
      // There's also __wasm_init_memory (not relevant yet, we don't
      // use passive segments) & __wasm_apply_global_relocs but
      // those are included in the start function and should have
      // been called upon instantiation, see
      // Writer::createStartFunction().
      if (instance.exports.__wasm_apply_data_relocs) {
        instance.exports.__wasm_apply_data_relocs();
      }

      instance.exports._initialize();
    }
  }

  get wasmMemoryBytes() {
    return this.#memory.buffer.byteLength;
  }

  setStdin(bytes) {
    if (this.#wasi && this.#wasi.fds) {
      this.#wasi.fds[0] = new wasi.OpenFile(
        new wasi.File(bytes, { readonly: true })
      );
    }
  }

  lookupSymbol(sym) {
    if (this.#gotMem[sym] && this.#gotMem[sym].value !== DyLD.#poison) {
      return this.#gotMem[sym].value;
    }
    if (this.#gotFunc[sym] && this.#gotFunc[sym].value !== DyLD.#poison) {
      return this.#gotFunc[sym].value;
    }
    // Not in GOT.func yet, create the entry on demand
    if (this.exportFuncs[sym]) {
      console.assert(!this.#gotFunc[sym]);
      const addr = this.#tableGrow(1, this.exportFuncs[sym]);
      this.#gotFunc[sym] = new WebAssembly.Global(
        { value: "i32", mutable: true },
        addr
      );
      return addr;
    }
    return 0;
  }
}

// The main entry point of dyld that may be run on node/browser, and
// may run either iserv defaultMain from the ghci library or an
// alternative entry point from another shared library
export async function main({
  rpc, // Handle the side effects of DyLD
  searchDirs, // Initial library search directories
  mainSoPath, // Could also be another shared library that's actually not ghci
  args, // WASI argv starting with the executable name. +RTS etc will be respected
  isIserv, // set to true when running iserv defaultServer
}) {
  try {
    const dyld = new DyLD({
      args,
      rpc,
    });
    for (const libdir of searchDirs) {
      await dyld.addLibrarySearchPath(libdir);
    }
    await dyld.loadDLLs(mainSoPath);

    // At this point, rts/ghc-internal are loaded, perform wasm shared
    // library specific RTS startup logic, see Note [JSFFI initialization]
    dyld.exportFuncs.__ghc_wasm_jsffi_init();

    // We're not running iserv, just return the dyld instance so user
    // could use it to invoke their exported functions, and don't
    // perform cleanup (see finally block)
    if (!isIserv) {
      return dyld;
    }

    // iserv-specific logic follows
    const reader = rpc.readStream.getReader();
    const writer = rpc.writeStream.getWriter();

    const cb_sig = (cb) => {
      rpc.installSignalHandlers(cb);
    };

    const cb_recv = async () => {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("not enough bytes");
      }
      return value;
    };
    const cb_send = (buf) => {
      writer.write(new Uint8Array(buf));
    };

    return await dyld.exportFuncs.defaultServer(cb_sig, cb_recv, cb_send);
  } finally {
    if (isIserv) {
      rpc.close();
    }
  }
}
