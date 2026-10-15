// Renders the app icons in public/ from assets/icon.svg, at the sizes phones ask for.
//
// Run with `node scripts/icons.ts` after changing the icon.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const FRONTEND = resolve(import.meta.dirname, "..");
const svg = readFileSync(join(FRONTEND, "assets", "icon.svg"), "utf8");

/** The file and its size in pixels. The maskable icon is the same: its art is in the safe zone. */
const ICONS: [string, number][] = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["icon-maskable-512.png", 512],
  ["apple-touch-icon.png", 180],
];

const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  for (const [file, size] of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<body style="margin:0">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`,
    );
    await page.screenshot({ path: join(FRONTEND, "public", file) });
    await page.close();
  }
} finally {
  await browser.close();
}
