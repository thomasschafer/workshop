// Taking a phone off the network, and putting it back, for tests of what works offline.
import type { BrowserContext, Route } from "@playwright/test";

/**
 * Refuses what would change anything on the server. Reads are left to the emulation, as in WebKit
 * a route sees them before the service worker does, which is what answers them offline.
 */
const cutOff = (route: Route) =>
  route.request().method() === "GET" ? route.fallback() : route.abort("internetdisconnected");

/**
 * Takes every page of `context` off the network, or puts them back. Chromium's emulation of no
 * network has let a request reach the server on a slow machine, so while offline, requests that
 * change anything are also refused before they leave the browser, as with no connection at all.
 */
export async function setOffline(context: BrowserContext, offline: boolean): Promise<void> {
  if (offline) {
    await context.route("**/*", cutOff);
    await context.setOffline(true);
    return;
  }
  await context.setOffline(false);
  await context.unroute("**/*", cutOff);
  // A phone says when it's back on the network, but Chromium doesn't tell a page opened while
  // the network was emulated away, which would leave the app waiting to try again on its own.
  for (const page of context.pages()) {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
  }
}
