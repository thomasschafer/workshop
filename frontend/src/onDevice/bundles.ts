// Client-side management of pinned on-device runtime bundles in dedicated Cache Storage buckets
// (`workshop-on-device-<id>@<version>`), with SHA-256 verification on both download and load.

import catalogJson from "../../../on-device/bundles.json";
import type { InstallStatus } from "../api";
import { request } from "../api";

export const ON_DEVICE_CACHE_PREFIX = "workshop-on-device-";

export interface BundleFileSpec {
  name: string;
  url: string;
  size: number;
  sha256: string;
  content_type: string;
}

export interface BundleSpec {
  id: string;
  version: string;
  language: string;
  engine: string;
  description: string;
  packages: string[];
  ghc_libdir: string;
  ghc_lib_search_dir: string;
  main_so_path: string;
  files: BundleFileSpec[];
}

export interface ServerBundleFileInfo {
  name: string;
  path: string;
  size: number;
  sha256: string;
  content_type: string;
}

export interface ServerBundleStatus {
  id: string;
  version: string;
  key: string;
  language: string;
  engine: string;
  description: string;
  packages: string[];
  ghc_libdir: string;
  ghc_lib_search_dir: string;
  main_so_path: string;
  total_bytes: number;
  installed_on_server: boolean;
  files: ServerBundleFileInfo[];
}

export interface ServerOnDeviceBundlesState {
  bundles: ServerBundleStatus[];
  download: InstallStatus;
}

export interface DeviceDownloadProgress {
  file: string;
  receivedBytes: number;
  totalBytes: number;
  stage: "downloading" | "verifying" | "saving";
}

export const BUNDLE_CATALOG: readonly BundleSpec[] = catalogJson.bundles;

export function bundleKey(bundle: Pick<BundleSpec, "id" | "version">): string {
  return `${bundle.id}@${bundle.version}`;
}

export function bundleCacheName(bundle: Pick<BundleSpec, "id" | "version">): string {
  return `${ON_DEVICE_CACHE_PREFIX}${bundleKey(bundle)}`;
}

export function bundleFileUrl(
  bundle: Pick<BundleSpec, "id" | "version">,
  fileName: string,
): string {
  return `/on-device/${bundleKey(bundle)}/${fileName}`;
}

export function bundleTotalBytes(bundle: Pick<BundleSpec, "files">): number {
  return bundle.files.reduce((sum, f) => sum + f.size, 0);
}

export function bundleForLanguage(languageId: string): BundleSpec | null {
  return BUNDLE_CATALOG.find((b) => b.language === languageId) ?? null;
}

export function bundleById(id: string): BundleSpec | null {
  return BUNDLE_CATALOG.find((b) => b.id === id) ?? null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer view so Web Crypto accepts both Uint8Array and SharedArrayBuffer-backed views.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

// Reactive mirror of which bundle IDs are cached on this device so synchronous UI selectors
// (like Coding list capability badges) update immediately without awaiting Cache Storage.
const cachedBundleIds = new Set<string>();
const listeners = new Set<() => void>();

function notifyCachedChange(): void {
  for (const listener of listeners) listener();
}

export function subscribeCachedBundles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isLanguageCachedSync(languageId: string): boolean {
  const bundle = bundleForLanguage(languageId);
  return bundle !== null && cachedBundleIds.has(bundle.id);
}

export function isBundleCachedSync(bundleId: string): boolean {
  return cachedBundleIds.has(bundleId);
}

export async function isBundleCachedOnDevice(bundle: BundleSpec): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  const cacheName = bundleCacheName(bundle);
  const names = await caches.keys();
  if (!names.includes(cacheName)) return false;
  const cache = await caches.open(cacheName);
  for (const file of bundle.files) {
    const matched = await cache.match(bundleFileUrl(bundle, file.name));
    if (!matched) return false;
  }
  return true;
}

/** Refreshes the in-memory cached-bundle mirror from Cache Storage. */
export async function refreshCachedBundles(): Promise<Set<string>> {
  const next = new Set<string>();
  for (const bundle of BUNDLE_CATALOG) {
    if (await isBundleCachedOnDevice(bundle)) {
      next.add(bundle.id);
    }
  }
  let changed = next.size !== cachedBundleIds.size;
  if (!changed) {
    for (const id of next) {
      if (!cachedBundleIds.has(id)) {
        changed = true;
        break;
      }
    }
  }
  if (changed) {
    cachedBundleIds.clear();
    for (const id of next) cachedBundleIds.add(id);
    notifyCachedChange();
  }
  return next;
}

/**
 * Downloads every pinned file of `bundle` from the Workshop server, verifies exact size and
 * SHA-256, writes verified responses into the bundle's dedicated Cache Storage bucket, and prunes
 * any older cached versions of the same bundle.
 */
export async function installBundleToDevice(
  bundle: BundleSpec,
  onProgress?: (progress: DeviceDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof caches === "undefined") {
    throw new Error("Cache Storage is unavailable in this browser context.");
  }
  const cacheName = bundleCacheName(bundle);
  const cache = await caches.open(cacheName);
  const totalBytes = bundleTotalBytes(bundle);
  let completedBeforeFile = 0;

  try {
    for (const file of bundle.files) {
      const url = bundleFileUrl(bundle, file.name);
      const existing = await cache.match(url);
      if (existing) {
        const buf = new Uint8Array(await existing.arrayBuffer());
        if (buf.byteLength === file.size && (await sha256Hex(buf)) === file.sha256) {
          completedBeforeFile += file.size;
          onProgress?.({
            file: file.name,
            receivedBytes: completedBeforeFile,
            totalBytes,
            stage: "verifying",
          });
          continue;
        }
        await cache.delete(url);
      }

      onProgress?.({
        file: file.name,
        receivedBytes: completedBeforeFile,
        totalBytes,
        stage: "downloading",
      });

      const response = await fetch(url, { cache: "no-store", ...(signal ? { signal } : {}) });
      if (!response.ok) {
        const text = (await response.text().catch(() => "")).trim();
        throw new Error(text || `Couldn't download ${file.name} (HTTP ${response.status}).`);
      }

      const bytes = await readResponseWithProgress(response, (loaded) => {
        onProgress?.({
          file: file.name,
          receivedBytes: completedBeforeFile + loaded,
          totalBytes,
          stage: "downloading",
        });
      });

      onProgress?.({
        file: file.name,
        receivedBytes: completedBeforeFile + bytes.byteLength,
        totalBytes,
        stage: "verifying",
      });

      if (bytes.byteLength !== file.size) {
        throw new Error(
          `${file.name} downloaded ${bytes.byteLength} bytes, expected ${file.size}.`,
        );
      }
      const actualSha = await sha256Hex(bytes);
      if (actualSha !== file.sha256) {
        throw new Error(
          `${file.name} SHA-256 mismatch (expected ${file.sha256.slice(0, 12)}…, got ${actualSha.slice(0, 12)}…).`,
        );
      }

      onProgress?.({
        file: file.name,
        receivedBytes: completedBeforeFile + bytes.byteLength,
        totalBytes,
        stage: "saving",
      });

      const body = new Uint8Array(bytes.byteLength);
      body.set(bytes);
      await cache.put(
        url,
        new Response(body, {
          status: 200,
          headers: {
            "Content-Type": file.content_type,
            "Content-Length": String(file.size),
            "X-Workshop-Sha256": file.sha256,
          },
        }),
      );
      completedBeforeFile += file.size;
    }
  } catch (err) {
    // Never leave a partial or unverified bundle cache behind.
    await caches.delete(cacheName).catch(() => {});
    cachedBundleIds.delete(bundle.id);
    notifyCachedChange();
    throw err;
  }

  // Prune older cached versions of the same bundle now that the new version is verified.
  const prefix = `${ON_DEVICE_CACHE_PREFIX}${bundle.id}@`;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix) && name !== cacheName)
      .map((name) => caches.delete(name)),
  );

  cachedBundleIds.add(bundle.id);
  notifyCachedChange();
}

async function readResponseWithProgress(
  response: Response,
  onLoaded: (bytes: number) => void,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onLoaded(bytes.byteLength);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onLoaded(loaded);
    }
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Deletes all cached versions of `bundleId` from this device's Cache Storage. */
export async function removeBundleFromDevice(bundleId: string): Promise<void> {
  if (typeof caches === "undefined") return;
  const prefix = `${ON_DEVICE_CACHE_PREFIX}${bundleId}@`;
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith(prefix)).map((n) => caches.delete(n)));
  cachedBundleIds.delete(bundleId);
  notifyCachedChange();
}

/**
 * Reads a pinned bundle file from Cache Storage and verifies its exact size and SHA-256 before
 * returning the bytes to a Worker. Works completely offline.
 */
export async function readVerifiedBundleFile(
  bundle: BundleSpec,
  fileName: string,
): Promise<Uint8Array> {
  const file = bundle.files.find((f) => f.name === fileName);
  if (!file) {
    throw new Error(`Unknown file ${fileName} in bundle ${bundleKey(bundle)}.`);
  }
  if (typeof caches === "undefined") {
    throw new Error("Cache Storage is unavailable in this worker.");
  }
  const cache = await caches.open(bundleCacheName(bundle));
  const response = await cache.match(bundleFileUrl(bundle, file.name));
  if (!response) {
    throw new Error(
      `${bundle.engine} isn't installed on this device yet. Download it in Settings → On-device.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== file.size) {
    throw new Error(
      `Cached ${file.name} is incomplete (${bytes.byteLength} of ${file.size} bytes). Re-download it in Settings → On-device.`,
    );
  }
  const actualSha = await sha256Hex(bytes);
  if (actualSha !== file.sha256) {
    throw new Error(
      `Cached ${file.name} failed SHA-256 verification. Re-download it in Settings → On-device.`,
    );
  }
  return bytes;
}

export const onDeviceApi = {
  bundles: () => request<ServerOnDeviceBundlesState>("GET", "/on-device/bundles"),
  downloadOnServer: (id: string) =>
    request<ServerOnDeviceBundlesState>(
      "POST",
      `/on-device/bundles/${encodeURIComponent(id)}/download`,
      undefined,
      { timeoutMs: 0 },
    ),
  cancelServerDownload: () =>
    request<ServerOnDeviceBundlesState>("POST", "/on-device/bundles/cancel"),
  deleteOnServer: (id: string) =>
    request<ServerOnDeviceBundlesState>("DELETE", `/on-device/bundles/${encodeURIComponent(id)}`),
};
