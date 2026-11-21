import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import preact from "@preact/preset-vite";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Injects the build's hashed asset list and release fingerprint into `dist/sw.js` so the service
 * worker precaches every chunk (including lazy ones like Markdown) without breaking open tabs on
 * an earlier release.
 */
function workshopServiceWorker(): Plugin {
  let outDir = "dist";
  return {
    name: "workshop-service-worker",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const swPath = join(outDir, "sw.js");
      const assetsDir = join(outDir, "assets");
      if (!existsSync(swPath) || !existsSync(assetsDir)) return;
      const assets = readdirSync(assetsDir)
        .sort()
        .map((file) => `/assets/${file}`);
      const release = createHash("sha256").update(assets.join("\n")).digest("hex").slice(0, 12);
      const source = readFileSync(swPath, "utf8");
      const injected = source
        .replace('/*__RELEASE__*/ "dev"', JSON.stringify(release))
        .replace("/*__PRECACHE_ASSETS__*/ []", JSON.stringify(assets));
      if (injected === source) {
        throw new Error("sw.js is missing the precache placeholders");
      }
      writeFileSync(swPath, injected);
    },
  };
}

export default defineConfig({
  plugins: [preact(), workshopServiceWorker()],
  // End-to-end tests in e2e/ run with Playwright instead.
  test: { include: ["src/**/*.test.ts"] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
