// The thread view keeps its composer drafts, settings and UI state in
// `localStorage`. A webview's origin is its own and its page is dropped while
// the tab is hidden, so `localStorage` here is the webview's state instead:
// `setState` survives hiding and reloads, and the host keeps a copy to carry
// into the tab it opens when a thread's URI changes.
import { post, vscodeApi } from "./bridge.ts";

interface WebviewState {
  readonly storage?: Readonly<Record<string, string>>;
}

const SAVE_DELAY_MS = 100;

/** The storage the webview's earlier page left, if this tab had one. */
export function savedStorage(): Readonly<Record<string, string>> | null {
  const state = vscodeApi.getState() as WebviewState | undefined;
  return state?.storage ?? null;
}

/** Replaces `window.localStorage` with one seeded from `initial`. */
export function installStorage(initial: Readonly<Record<string, string>>): void {
  const items = new Map(Object.entries(initial));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    timer = undefined;
    const storage = Object.fromEntries(items);
    vscodeApi.setState({ storage } satisfies WebviewState);
    post({ type: "storage", storage });
  };
  const changed = () => {
    timer ??= setTimeout(save, SAVE_DELAY_MS);
  };
  // The page can go any time the tab hides; a pending write goes first.
  window.addEventListener("pagehide", () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    save();
  });

  const storage: Storage = {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      const text = String(value);
      if (items.get(key) === text) return;
      items.set(key, text);
      changed();
    },
    removeItem: (key) => {
      if (items.delete(key)) changed();
    },
    clear: () => {
      if (items.size === 0) return;
      items.clear();
      changed();
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => storage });
}
