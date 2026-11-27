import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeDbOptions {
  failTransaction?: () => Error | null;
  abortTransactions?: boolean;
}

/** Minimal IndexedDB mock supporting `onclose`, `transaction()` errors, and `tx.onabort`. */
function installFakeIndexedDb(dbs: FakeDbOptions[]) {
  const stores = new Map<string, Map<IDBValidKey, unknown>>();
  const instances: {
    onclose: (() => void) | null;
    onversionchange: (() => void) | null;
    closed: boolean;
  }[] = [];
  let openCalls = 0;

  const getStore = (name: string) => {
    let map = stores.get(name);
    if (!map) {
      map = new Map();
      stores.set(name, map);
    }
    return map;
  };

  const indexedDB = {
    open: vi.fn(() => {
      const idx = openCalls++;
      const cfg = dbs[Math.min(idx, dbs.length - 1)] ?? {};
      const req: {
        result: unknown;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = {
        result: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      const db = {
        objectStoreNames: { contains: () => true },
        onclose: null as (() => void) | null,
        onversionchange: null as (() => void) | null,
        closed: false,
        close() {
          this.closed = true;
        },
        transaction(storeName: string, _mode: IDBTransactionMode) {
          if (this.closed) {
            throw new DOMException("The database connection is closing.", "InvalidStateError");
          }
          const err = cfg.failTransaction?.();
          if (err) throw err;
          const map = getStore(storeName);
          const tx: {
            error: DOMException | null;
            oncomplete: (() => void) | null;
            onerror: (() => void) | null;
            onabort: (() => void) | null;
            objectStore: (name: string) => unknown;
          } = {
            error: null,
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore: () => ({
              get(key: IDBValidKey) {
                const r: {
                  result: unknown;
                  error: DOMException | null;
                  onsuccess: (() => void) | null;
                  onerror: (() => void) | null;
                } = { result: map.get(key), error: null, onsuccess: null, onerror: null };
                queueMicrotask(() => {
                  if (cfg.abortTransactions) {
                    tx.error = new DOMException("Aborted by storage eviction", "AbortError");
                    tx.onabort?.();
                    return;
                  }
                  r.onsuccess?.();
                  queueMicrotask(() => tx.oncomplete?.());
                });
                return r;
              },
              getAll() {
                const r: {
                  result: unknown;
                  error: DOMException | null;
                  onsuccess: (() => void) | null;
                  onerror: (() => void) | null;
                } = { result: [...map.values()], error: null, onsuccess: null, onerror: null };
                queueMicrotask(() => {
                  if (cfg.abortTransactions) {
                    tx.error = new DOMException("Aborted", "AbortError");
                    tx.onabort?.();
                    return;
                  }
                  r.onsuccess?.();
                  queueMicrotask(() => tx.oncomplete?.());
                });
                return r;
              },
              put(value: { key?: IDBValidKey; year?: IDBValidKey }) {
                const k = value.key ?? value.year;
                if (k !== undefined) map.set(k, value);
                const r: {
                  result: unknown;
                  error: DOMException | null;
                  onsuccess: (() => void) | null;
                  onerror: (() => void) | null;
                } = { result: k, error: null, onsuccess: null, onerror: null };
                queueMicrotask(() => {
                  if (cfg.abortTransactions) {
                    tx.error = new DOMException("Aborted", "AbortError");
                    tx.onabort?.();
                    return;
                  }
                  r.onsuccess?.();
                  queueMicrotask(() => tx.oncomplete?.());
                });
                return r;
              },
              delete(key: IDBValidKey) {
                map.delete(key);
              },
            }),
          };
          return tx;
        },
      };
      instances.push(db);
      req.result = db;
      queueMicrotask(() => req.onsuccess?.());
      return req;
    }),
  };

  vi.stubGlobal("indexedDB", indexedDB);
  return { indexedDB, instances };
}

async function loadDb() {
  vi.resetModules();
  return import("./db");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline IndexedDB recovery", () => {
  it("reopens after db.onclose fires (e.g. iOS Safari background eviction)", async () => {
    const { indexedDB, instances } = installFakeIndexedDb([{}, {}]);
    const db = await loadDb();

    await db.putSnapshot("home", { ok: 1 });
    expect(indexedDB.open).toHaveBeenCalledTimes(1);

    // Simulate WebKit closing the idle connection in the background.
    const first = instances[0];
    if (!first) throw new Error("expected first IDB instance");
    first.closed = true;
    first.onclose?.();

    const snap = await db.getSnapshot<{ ok: number }>("home");
    expect(indexedDB.open).toHaveBeenCalledTimes(2);
    expect(snap?.value).toEqual({ ok: 1 });
  });

  it("reopens once when db.transaction throws InvalidStateError", async () => {
    let failed = false;
    const { indexedDB } = installFakeIndexedDb([
      {
        failTransaction: () => {
          if (!failed) {
            failed = true;
            return new DOMException("Connection closed", "InvalidStateError");
          }
          return null;
        },
      },
      {},
    ]);
    const db = await loadDb();

    await db.putSnapshot("k", "v1");
    expect(indexedDB.open).toHaveBeenCalledTimes(2);
    expect((await db.getSnapshot<string>("k"))?.value).toBe("v1");
  });

  it("does not swallow non-InvalidStateError transaction errors", async () => {
    installFakeIndexedDb([
      {
        failTransaction: () => new DOMException("No such store", "NotFoundError"),
      },
    ]);
    const db = await loadDb();

    await expect(db.getSnapshot("k")).rejects.toThrow("No such store");
  });

  it("rejects rather than hanging when a multi-step transaction aborts", async () => {
    installFakeIndexedDb([{ abortTransactions: true }]);
    const db = await loadDb();

    await expect(db.mergeAocPuzzle(2025, 1, { input: "123" })).rejects.toThrow(/Aborted/);
    await expect(db.mergeAocYear(2025, { stars: { "1": 1 } })).rejects.toThrow(/Aborted/);
    await expect(db.deleteAocYear(2025)).rejects.toThrow(/Aborted/);
  });
});
