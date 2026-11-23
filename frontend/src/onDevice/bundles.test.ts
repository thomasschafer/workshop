import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BundleSpec,
  bundleCacheName,
  bundleFileUrl,
  installBundleToDevice,
  isBundleCachedOnDevice,
  readVerifiedBundleFile,
  removeBundleFromDevice,
  sha256Hex,
} from "./bundles";

class MemoryCache {
  private readonly store = new Map<string, Response>();

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const key = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
    return this.store.get(key)?.clone();
  }

  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    const key = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
    this.store.set(key, res.clone());
  }

  async delete(req: RequestInfo | URL): Promise<boolean> {
    const key = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
    return this.store.delete(key);
  }
}

class MemoryCacheStorage {
  readonly buckets = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = new MemoryCache();
      this.buckets.set(name, bucket);
    }
    return bucket;
  }

  async keys(): Promise<string[]> {
    return [...this.buckets.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.buckets.delete(name);
  }
}

describe("on-device bundle cache & SHA-256 verification", () => {
  let cacheStorage: MemoryCacheStorage;
  let testBundle: BundleSpec;
  const payload = new TextEncoder().encode("hello-wasm-bundle");

  beforeEach(async () => {
    cacheStorage = new MemoryCacheStorage();
    vi.stubGlobal("caches", cacheStorage);
    const sha = await sha256Hex(payload);
    testBundle = {
      id: "test-ghc",
      version: "2.0.0",
      language: "haskell",
      engine: "Test GHC",
      description: "Test bundle",
      packages: ["base"],
      ghc_libdir: "/tmp/hslib/lib",
      ghc_lib_search_dir: "/tmp/hslib/lib/ghc",
      main_so_path: "/tmp/main.so",
      files: [
        {
          name: "bundle.bin",
          url: "https://example.invalid/bundle.bin",
          size: payload.byteLength,
          sha256: sha,
          content_type: "application/octet-stream",
        },
      ],
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies SHA-256 on install, prunes old versions, and reads back verified bytes", async () => {
    // Seed an older version bucket to verify upgrade pruning.
    await cacheStorage.open("workshop-on-device-test-ghc@1.0.0");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(payload, { status: 200 })),
    );

    const stages: string[] = [];
    await installBundleToDevice(testBundle, (p) => stages.push(p.stage));

    expect(stages).toContain("downloading");
    expect(stages).toContain("verifying");
    expect(stages).toContain("saving");
    expect(await isBundleCachedOnDevice(testBundle)).toBe(true);
    expect(await cacheStorage.keys()).toEqual([bundleCacheName(testBundle)]);

    const loaded = await readVerifiedBundleFile(testBundle, "bundle.bin");
    expect(new TextDecoder().decode(loaded)).toBe("hello-wasm-bundle");

    await removeBundleFromDevice("test-ghc");
    expect(await isBundleCachedOnDevice(testBundle)).toBe(false);
  });

  it("rejects corrupt downloads and leaves no partial cache behind", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(new TextEncoder().encode("corrupt-wasm-data"), { status: 200 }),
      ),
    );

    await expect(installBundleToDevice(testBundle)).rejects.toThrow(/SHA-256 mismatch/);
    expect(await isBundleCachedOnDevice(testBundle)).toBe(false);
    expect(await cacheStorage.keys()).toEqual([]);
  });

  it("rejects tampered cached files on load", async () => {
    const cache = await cacheStorage.open(bundleCacheName(testBundle));
    await cache.put(
      bundleFileUrl(testBundle, "bundle.bin"),
      new Response(new TextEncoder().encode("tampered-payload!"), { status: 200 }),
    );
    await expect(readVerifiedBundleFile(testBundle, "bundle.bin")).rejects.toThrow(
      /failed SHA-256 verification/,
    );
  });
});
