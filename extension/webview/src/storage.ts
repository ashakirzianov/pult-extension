// The thread view keeps its composer drafts, settings and UI state in
// `localStorage`. A webview's origin is its own, and VS Code drops a hidden
// tab's page without unloading it, so `localStorage` here is the tab's state
// instead, and every write leaves the page as it happens: into `setState`,
// which survives hiding and window reloads, and to the host, which carries it
// into the tab it opens when the tab's URI changes.
import type { TabStorage } from "../../src/threads/protocol.ts";
import { onHostMessage, post, vscodeApi } from "./bridge.ts";
import { createTabStorage } from "./tabStorage.ts";

interface WebviewState {
  readonly storage?: TabStorage;
}

/** The storage this tab's earlier page left, if it had one. */
export function savedStorage(): TabStorage | null {
  const state = vscodeApi.getState() as WebviewState | undefined;
  return state?.storage ?? null;
}

/** Replaces `window.localStorage` with the tab's, starting from `initial`. */
export function installStorage(initial: TabStorage): void {
  const save = (storage: TabStorage) => vscodeApi.setState({ storage } satisfies WebviewState);
  save(initial);
  const storage = createTabStorage(initial, (items, changes) => {
    save(items);
    post({ type: "storage", changes });
  });
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => storage });
}

/**
 * Answers the host's `flush`. A write is reported by the end of the task that
 * made it, and the host reads the page's messages in order, so by the answer
 * it has every write.
 */
export function answerFlushes(): void {
  onHostMessage((message) => {
    if (message.type === "flush") post({ type: "flushed", requestId: message.requestId });
  });
}
