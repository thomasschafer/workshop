import { render } from "preact";
import {
  api,
  type Bootstrap,
  bootstrapWasStale,
  connection,
  isTransientNetworkError,
  markBootstrapStale,
} from "./api";
import { errorMessage } from "./errors";
import { readCachedBootstrap, writeCachedBootstrap } from "./offline/bootstrap";
import "./styles.css";
import { applyThemeCss } from "./theme";
import { Shell } from "./tracks/shell";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("missing #root element");
}
const root: HTMLElement = rootEl;

window.addEventListener("error", (event) => {
  api.log("error", `${event.message} at ${event.filename}:${event.lineno}`);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason =
    event.reason instanceof Error
      ? (event.reason.stack ?? event.reason.message)
      : String(event.reason);
  api.log("error", `unhandled rejection: ${reason}`);
});

// Keeps the app on the device, so puzzles and short items work offline.
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch((e: unknown) => {
    api.log("error", `couldn't keep the app for offline use: ${errorMessage(e)}`);
  });
}

function start(boot: Bootstrap): void {
  applyThemeCss(boot.theme_css);
  render(<Shell boot={boot} />, root);
}

const cachedBoot = readCachedBootstrap();
if (cachedBoot && typeof navigator !== "undefined" && navigator.onLine === false) {
  // Boot immediately from the local copy when the OS already knows there's no network, so the
  // PWA splash screen dismisses right away and Shell refreshes once connectivity returns.
  connection.set(false);
  markBootstrapStale();
  start(cachedBoot);
} else {
  api
    .bootstrap(cachedBoot ? { timeoutMs: 2_000 } : undefined)
    .then((boot) => {
      if (bootstrapWasStale && cachedBoot) {
        start(cachedBoot);
        return;
      }
      if (!bootstrapWasStale) writeCachedBootstrap(boot);
      start(boot);
    })
    .catch((error: unknown) => {
      if (cachedBoot && isTransientNetworkError(error)) {
        connection.set(false);
        markBootstrapStale();
        start(cachedBoot);
        return;
      }
      root.innerHTML = "";
      const p = document.createElement("p");
      p.className = "pane error-text";
      p.textContent = `Couldn't start Workshop: ${errorMessage(error)}`;
      root.append(p);
    });
}
