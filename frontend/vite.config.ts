import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [preact()],
  // End-to-end tests in e2e/ run with Playwright instead.
  test: { include: ["src/**/*.test.ts"] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
