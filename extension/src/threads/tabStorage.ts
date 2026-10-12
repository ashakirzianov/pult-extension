// A thread tab's `localStorage` (`webview/src/storage.ts`) as the host keeps
// it: the page reports every write, and the host carries the result into the
// tab it opens when the tab's URI changes. Upstream's app keeps one
// `localStorage` for every thread; a tab keeps its drafts to itself, and the
// rest of its writes make up the window's share, which every new tab starts
// from: client settings, UI state, and the composer's remembered model and
// provider.
import { type StorageChanges, TAB_DRAFT_KEY_PREFIX, type TabStorage } from "./protocol.ts";

// Upstream's `COMPOSER_DRAFT_STORAGE_KEY` (`webview/t3/src/composerDraftStore.ts`):
// its drafts are a tab's, and the fields it remembers across drafts the window's.
const COMPOSER_KEY = "t3code:composer-drafts:v1";
const COMPOSER_SHARED_FIELDS = new Set([
  "stickyModelSelectionByProvider",
  "stickyOptionsByModelByProvider",
  "stickyActiveProvider",
]);

export function applyChanges(storage: TabStorage, changes: StorageChanges): TabStorage {
  const next: Record<string, string> = { ...storage };
  for (const [key, value] of changes) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * The window's share after a tab's writes: every key but its drafts, and of
 * the composer's, the fields it remembers across drafts, which the composer
 * reads as a store with none. The same object when nothing in it changed.
 */
export function shareChanges(shared: TabStorage, changes: StorageChanges): TabStorage {
  let next: Record<string, string> | null = null;
  for (const [key, written] of changes) {
    if (key.startsWith(TAB_DRAFT_KEY_PREFIX)) continue;
    const value = key === COMPOSER_KEY ? composerShare(written) : written;
    // A composer store removed or unread forgets its drafts, not the window's choices.
    if (key === COMPOSER_KEY && value === null) continue;
    const current = next ?? shared;
    if ((current[key] ?? null) === value) continue;
    next ??= { ...shared };
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next ?? shared;
}

/** The window's share with the keys it lacks taken from a tab's storage, as a tab saved it before sharing began. */
export function fillShare(shared: TabStorage, storage: TabStorage): TabStorage {
  return shareChanges(
    shared,
    Object.entries(storage).filter(([key]) => !(key in shared)),
  );
}

function composerShare(value: string | null): string | null {
  if (value === null) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof stored !== "object" || stored === null || !("state" in stored)) return null;
  const { state } = stored;
  if (typeof state !== "object" || state === null) return null;
  const fields = Object.entries(state).filter(([field]) => COMPOSER_SHARED_FIELDS.has(field));
  const version = "version" in stored ? stored.version : undefined;
  return JSON.stringify({ state: Object.fromEntries(fields), version });
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
