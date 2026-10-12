// A thread tab's `localStorage` (`webview/src/storage.ts`) as the host keeps
// it: the page reports every write, and the host carries the result into the
// tab it opens when the tab's URI changes.
import type { StorageChanges, TabStorage } from "./protocol.ts";

export function applyChanges(storage: TabStorage, changes: StorageChanges): TabStorage {
  const next: Record<string, string> = { ...storage };
  for (const [key, value] of changes) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}
