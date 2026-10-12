// Stands in for the copy's `src/lib/storage.ts` (`../../stubs.ts`): the same
// storages, but a deferred one writes at once. Upstream holds the composer's
// writes for 300 ms and flushes them early only on `beforeunload`, which a
// thread tab's page never sees: VS Code drops a hidden tab's page without
// unloading it, and with it whatever the composer had not yet written.
import type * as Upstream from "../../t3/src/lib/storage";

export type StateStorage<R = unknown> = Upstream.StateStorage<R>;
export type DeferredStorage<TValue> = Upstream.DeferredStorage<TValue>;

export const createMemoryStorage: typeof Upstream.createMemoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
};

export const resolveStorage: typeof Upstream.resolveStorage = (storage) =>
  typeof storage?.getItem === "function" &&
  typeof storage.setItem === "function" &&
  typeof storage.removeItem === "function"
    ? (storage as StateStorage)
    : createMemoryStorage();

export const createDeferredStorage: typeof Upstream.createDeferredStorage = <TValue>(
  baseStorage: Partial<StateStorage> | null | undefined,
  serialize: (value: TValue) => string,
): DeferredStorage<TValue> => {
  const storage = resolveStorage(baseStorage);
  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      storage.setItem(name, serialize(value));
    },
    removeItem: (name) => {
      storage.removeItem(name);
    },
    // Nothing waits to be written.
    flush: () => {},
  };
};
