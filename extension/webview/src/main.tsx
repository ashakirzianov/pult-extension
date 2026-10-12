// The thread bundle's entry. The page asks the host for its tab's thread and
// environment, swaps the browser APIs the thread view leans on for the
// webview's equivalents, and only then loads the view, whose modules read
// storage and settings as they load.
import type { Unavailable } from "../../src/threads/protocol.ts";
import { installBridgedFetch, nextHostMessage, post } from "./bridge.ts";
import { startSession } from "./session.ts";
import { answerFlushes, installStorage, savedStorage } from "./storage.ts";
import { installProbe } from "./probe.ts";
import { followVsCodeTheme } from "./theme.ts";

// The host only sends `test.*` messages outside production.
installProbe();
answerFlushes();
// The page's errors go to the extension host's log.
window.addEventListener("error", (event) =>
  post({ type: "log", text: String(event.error ?? event.message) }),
);
window.addEventListener("unhandledrejection", (event) =>
  post({ type: "log", text: `Unhandled rejection: ${String(event.reason)}` }),
);

async function start() {
  followVsCodeTheme();
  // Links leave through the host; a webview cannot open windows.
  window.open = (url) => {
    if (url !== undefined) post({ type: "openExternal", url: String(url) });
    return null;
  };
  const init = nextHostMessage("init");
  post({ type: "ready", storage: savedStorage() });
  const { target, environment, storage, development } = await init;
  installStorage(storage);
  const root = document.getElementById("root")!;
  if ("reason" in environment) {
    showUnavailable(root, environment);
    return;
  }
  installBridgedFetch(new URL(environment.httpBaseUrl).origin);
  startSession({ environment, target, development });
  const { mountThreadApp } = await import("./ThreadApp.tsx");
  mountThreadApp(root);
}

function showUnavailable(root: HTMLElement, unavailable: Unavailable) {
  const message = document.createElement("p");
  message.className = "pult-unavailable";
  if (unavailable.reason === "unbound") {
    message.textContent = "Pult is not connected to a T3 Code environment. ";
    const connect = document.createElement("a");
    connect.href = "#";
    connect.textContent = "Connect";
    connect.addEventListener("click", (event) => {
      event.preventDefault();
      post({ type: "command", command: "pult.connect" });
    });
    message.append(connect);
  } else {
    message.textContent = `This thread belongs to ${unavailable.label}, and this window is connected to another environment.`;
  }
  root.replaceChildren(message);
}

start().catch((error: unknown) => {
  post({ type: "log", text: `The thread view failed to start: ${String(error)}` });
  const message = document.createElement("pre");
  message.className = "pult-unavailable";
  message.textContent = `The thread view failed to start.\n\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  document.getElementById("root")?.replaceChildren(message);
});
