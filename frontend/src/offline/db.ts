// Client-side IndexedDB cache for large offline blobs: AoC puzzles/inputs/helpers, Coding track
// bundles (including hidden tests & precomputed oracle cases in a dedicated store), and cached
// snapshots (Home, Goals, Mistakes, Design prompts).
//
// Small synchronous state (`workshop:learning` and `workshop:outbox`) stays in localStorage so
// rendering and strict event ordering stay synchronous.

import type { DayMeta, Problem, StarTimes, VersionedFile } from "../api";

const DB_NAME = "workshop-offline";
const DB_VERSION = 1;

export type StoreName =
  | "snapshots"
  | "aoc"
  | "aocYear"
  | "helpers"
  | "codingBundle"
  | "codingTests";

export interface SnapshotRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
}

export interface CachedAocPuzzle {
  /** `${year}-${day}`. */
  key: string;
  year: number;
  day: number;
  problem?: Problem;
  /** How many puzzle parts are present in `problem` (1 or 2). */
  problemParts?: number;
  input?: string;
  code?: VersionedFile;
  notes?: VersionedFile;
  fileUri?: string;
  meta?: DayMeta;
  updatedAt: number;
}

export interface CachedAocYear {
  year: number;
  stars?: Record<string, number>;
  times?: Record<string, StarTimes>;
  updatedAt: number;
}

export interface CachedHelpers {
  languageId: string;
  file: string;
  text: string;
  updatedAt: number;
}

export interface StorageDiagnostics {
  available: boolean;
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
}

let opened: Promise<IDBDatabase | null> | null = null;

function isInvalidStateError(err: unknown): boolean {
  return err instanceof Error && err.name === "InvalidStateError";
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (opened) return opened;
  const opening: Promise<IDBDatabase | null> = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("snapshots")) {
          db.createObjectStore("snapshots", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("aoc")) {
          db.createObjectStore("aoc", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("aocYear")) {
          db.createObjectStore("aocYear", { keyPath: "year" });
        }
        if (!db.objectStoreNames.contains("helpers")) {
          db.createObjectStore("helpers", { keyPath: "languageId" });
        }
        if (!db.objectStoreNames.contains("codingBundle")) {
          db.createObjectStore("codingBundle", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("codingTests")) {
          db.createObjectStore("codingTests", { keyPath: "key" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const reset = () => {
          if (opened === opening) opened = null;
        };
        db.onversionchange = () => {
          db.close();
          reset();
        };
        // WebKit closes idle connections when backgrounded on iOS; drop the handle so the next
        // operation reopens cleanly.
        db.onclose = reset;
        resolve(db);
      };
      req.onerror = () => {
        if (opened === opening) opened = null;
        resolve(null);
      };
    } catch {
      if (opened === opening) opened = null;
      resolve(null);
    }
  });
  opened = opening;
  return opening;
}

/**
 * Runs a single IndexedDB transaction, reopening the database once if `db.transaction` throws
 * `InvalidStateError` (such as after iOS Safari evicts an idle connection). Other errors and
 * transaction aborts propagate instead of failing silently or hanging.
 */
async function withTx<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  exec: (store: IDBObjectStore) => IDBRequest<T> | undefined,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openDb();
    if (!db) return null;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, mode);
    } catch (err) {
      if (attempt === 0 && isInvalidStateError(err)) {
        opened = null;
        continue;
      }
      throw err;
    }
    return await new Promise<T | null>((resolve, reject) => {
      let value: T | null = null;
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      tx.onerror = () => fail(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () =>
        fail(tx.error ?? new DOMException("IndexedDB transaction aborted.", "AbortError"));
      try {
        const req = exec(tx.objectStore(storeName));
        if (req) {
          req.onsuccess = () => {
            value = req.result ?? null;
          };
          req.onerror = () => fail(req.error ?? tx.error ?? new Error("IndexedDB request failed."));
        }
      } catch (err) {
        fail(err);
      }
    });
  }
  return null;
}

function runTx<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return withTx(storeName, mode, work);
}

export async function getSnapshot<T>(key: string): Promise<SnapshotRecord<T> | null> {
  const row = await runTx<SnapshotRecord<T> | undefined>("snapshots", "readonly", (s) =>
    s.get(key),
  );
  return row ?? null;
}

export async function putSnapshot<T>(key: string, value: T): Promise<void> {
  await runTx("snapshots", "readwrite", (s) =>
    s.put({ key, value, updatedAt: Date.now() } satisfies SnapshotRecord<T>),
  );
}

export function aocKey(year: number, day: number): string {
  return `${year}-${day}`;
}

export async function getAocPuzzle(year: number, day: number): Promise<CachedAocPuzzle | null> {
  const row = await runTx<CachedAocPuzzle | undefined>("aoc", "readonly", (s) =>
    s.get(aocKey(year, day)),
  );
  return row ?? null;
}

export async function listAocPuzzles(): Promise<CachedAocPuzzle[]> {
  const rows = await runTx<CachedAocPuzzle[]>("aoc", "readonly", (s) => s.getAll());
  return rows ?? [];
}

/** Deletes all cached AoC puzzle records for a given year from this device. */
export async function deleteAocYear(year: number): Promise<void> {
  await withTx<undefined>("aoc", "readwrite", (store) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const rows = (req.result as CachedAocPuzzle[] | undefined) ?? [];
      for (const row of rows) {
        if (row.year === year) store.delete(row.key);
      }
    };
    return undefined;
  });
}

/** Merges fields into a puzzle's cached record so partial updates keep earlier data intact. */
export async function mergeAocPuzzle(
  year: number,
  day: number,
  patch: Partial<Omit<CachedAocPuzzle, "key" | "year" | "day" | "updatedAt">>,
): Promise<void> {
  await withTx<undefined>("aoc", "readwrite", (store) => {
    const key = aocKey(year, day);
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const existing = (getReq.result as CachedAocPuzzle | undefined) ?? {
        key,
        year,
        day,
        updatedAt: Date.now(),
      };
      const next: CachedAocPuzzle = {
        ...existing,
        ...patch,
        key,
        year,
        day,
        updatedAt: Date.now(),
      };
      if (patch.problem !== undefined) {
        next.problemParts = patch.problem.parts_html.length;
      }
      store.put(next);
    };
    return undefined;
  });
}

export async function getAocYear(year: number): Promise<CachedAocYear | null> {
  const row = await runTx<CachedAocYear | undefined>("aocYear", "readonly", (s) => s.get(year));
  return row ?? null;
}

export async function mergeAocYear(
  year: number,
  patch: Partial<Omit<CachedAocYear, "year" | "updatedAt">>,
): Promise<void> {
  await withTx<undefined>("aocYear", "readwrite", (store) => {
    const getReq = store.get(year);
    getReq.onsuccess = () => {
      const existing = (getReq.result as CachedAocYear | undefined) ?? {
        year,
        updatedAt: Date.now(),
      };
      store.put({ ...existing, ...patch, year, updatedAt: Date.now() });
    };
    return undefined;
  });
}

export async function getHelpers(languageId: string): Promise<CachedHelpers | null> {
  const row = await runTx<CachedHelpers | undefined>("helpers", "readonly", (s) =>
    s.get(languageId),
  );
  return row ?? null;
}

export async function putHelpers(languageId: string, file: string, text: string): Promise<void> {
  await runTx("helpers", "readwrite", (s) =>
    s.put({ languageId, file, text, updatedAt: Date.now() } satisfies CachedHelpers),
  );
}

export async function getRecord<T>(store: StoreName, key: IDBValidKey): Promise<T | null> {
  const row = await runTx<T | undefined>(store, "readonly", (s) => s.get(key));
  return row ?? null;
}

export async function putRecord<T>(store: StoreName, value: T): Promise<void> {
  await runTx(store, "readwrite", (s) => s.put(value));
}

export async function listRecords<T>(store: StoreName): Promise<T[]> {
  const rows = await runTx<T[]>(store, "readonly", (s) => s.getAll());
  return rows ?? [];
}

export async function clearStore(store: StoreName): Promise<void> {
  await runTx(store, "readwrite", (s) => s.clear());
}

export async function storageDiagnostics(): Promise<StorageDiagnostics> {
  const available = typeof indexedDB !== "undefined";
  const manager = typeof navigator !== "undefined" ? navigator.storage : undefined;
  let persisted: boolean | null = null;
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  if (manager) {
    try {
      if (typeof manager.persisted === "function") persisted = await manager.persisted();
    } catch {
      persisted = null;
    }
    try {
      if (typeof manager.estimate === "function") {
        const est = await manager.estimate();
        usageBytes = est.usage ?? null;
        quotaBytes = est.quota ?? null;
      }
    } catch {
      usageBytes = null;
      quotaBytes = null;
    }
  }
  return { available, persisted, usageBytes, quotaBytes };
}

export async function requestPersistentStorage(): Promise<boolean> {
  const manager = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!manager || typeof manager.persist !== "function") return false;
  try {
    return await manager.persist();
  } catch {
    return false;
  }
}
