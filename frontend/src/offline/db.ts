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

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (opened) return opened;
  opened = new Promise((resolve) => {
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
        db.onversionchange = () => {
          db.close();
          opened = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        opened = null;
        resolve(null);
      };
    } catch {
      opened = null;
      resolve(null);
    }
  });
  return opened;
}

function runTx<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const req = work(store);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
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
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction("aoc", "readwrite");
      const store = tx.objectStore("aoc");
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as CachedAocPuzzle[] | undefined) ?? [];
        for (const row of rows) {
          if (row.year === year) store.delete(row.key);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Merges fields into a puzzle's cached record so partial updates keep earlier data intact. */
export async function mergeAocPuzzle(
  year: number,
  day: number,
  patch: Partial<Omit<CachedAocPuzzle, "key" | "year" | "day" | "updatedAt">>,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction("aoc", "readwrite");
      const store = tx.objectStore("aoc");
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
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
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
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction("aocYear", "readwrite");
      const store = tx.objectStore("aocYear");
      const getReq = store.get(year);
      getReq.onsuccess = () => {
        const existing = (getReq.result as CachedAocYear | undefined) ?? {
          year,
          updatedAt: Date.now(),
        };
        store.put({ ...existing, ...patch, year, updatedAt: Date.now() });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
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
