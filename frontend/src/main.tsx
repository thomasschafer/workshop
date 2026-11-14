import { render } from "preact";
import { api } from "./api";
import { errorMessage } from "./errors";
import "./styles.css";
import { applyThemeCss } from "./theme";
import { Shell } from "./tracks/shell";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

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

// Keeps the app on the device, so short items can be practised offline.
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch((e: unknown) => {
    api.log("error", `couldn't keep the app for offline use: ${errorMessage(e)}`);
  });
}

api
  .bootstrap()
  .then((boot) => {
    applyThemeCss(boot.theme_css);
    render(<Shell boot={boot} />, root);
  })
  .catch((error: unknown) => {
    root.innerHTML = "";
    const p = document.createElement("p");
    p.className = "pane error-text";
    p.textContent = `Couldn't start Workshop: ${error instanceof Error ? error.message : String(error)}`;
    root.append(p);
  });
