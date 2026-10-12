import type { StorageChanges, TabStorage } from "../../src/threads/protocol.ts";

/**
 * A `Storage` over `initial` that reports its writes before the page can be
 * dropped: once, at the end of the task that made them, with every item and
 * the writes since the last report.
 */
export function createTabStorage(
  initial: TabStorage,
  report: (items: TabStorage, changes: StorageChanges) => void,
): Storage {
  const items = new Map(Object.entries(initial));
  let pending: Map<string, string | null> | null = null;
  const changed = (key: string, value: string | null) => {
    if (pending === null) {
      const changes = (pending = new Map());
      queueMicrotask(() => {
        pending = null;
        report(Object.fromEntries(items), [...changes]);
      });
    }
    pending.set(key, value);
  };

  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      const text = String(value);
      if (items.get(key) === text) return;
      items.set(key, text);
      changed(key, text);
    },
    removeItem: (key) => {
      if (items.delete(key)) changed(key, null);
    },
    clear: () => {
      for (const key of items.keys()) {
        items.delete(key);
        changed(key, null);
      }
    },
  };
}
