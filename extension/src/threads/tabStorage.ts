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

/**
 * Storage carried from a tab to the one that replaces it, by the new tab's URI
 * and column: a thread open in two groups reopens twice at one URI.
 */
export class CarriedStorage {
  private readonly entries: Array<{
    readonly uri: string;
    readonly column: number | undefined;
    readonly storage: TabStorage;
  }> = [];

  /** Holds `storage` for the tab about to open; the returned function drops it if none took it. */
  put(uri: string, column: number | undefined, storage: TabStorage): () => void {
    const entry = { uri, column, storage };
    this.entries.push(entry);
    return () => this.remove(entry);
  }

  take(uri: string, column: number | undefined): TabStorage | null {
    const entry =
      this.entries.find((each) => each.uri === uri && each.column === column) ??
      this.entries.find((each) => each.uri === uri);
    if (entry === undefined) return null;
    this.remove(entry);
    return entry.storage;
  }

  private remove(entry: (typeof this.entries)[number]) {
    const index = this.entries.indexOf(entry);
    if (index !== -1) this.entries.splice(index, 1);
  }
}
