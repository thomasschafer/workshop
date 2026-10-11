import { render } from "preact";
import { api } from "./api";
import { App } from "./app";
import "./styles.css";

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

api
  .bootstrap()
  .then((boot) => render(<App boot={boot} />, root))
  .catch((error: unknown) => {
    root.innerHTML = "";
    const p = document.createElement("p");
    p.className = "pane error-text";
    p.textContent = `Couldn't start Workshop: ${error instanceof Error ? error.message : String(error)}`;
    root.append(p);
  });
