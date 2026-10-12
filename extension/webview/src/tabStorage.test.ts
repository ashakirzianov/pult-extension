import { describe, expect, it, vi } from "vite-plus/test";

import { createDeferredStorage, createMemoryStorage } from "./stubs/storage.ts";
import { createTabStorage } from "./tabStorage.ts";

describe("createTabStorage", () => {
  it("reports a task's writes together before the next task", async () => {
    const report = vi.fn();
    const storage = createTabStorage({ kept: "1", gone: "2" }, report);
    storage.setItem("draft", "hello");
    storage.setItem("draft", "hello, world");
    storage.removeItem("gone");
    storage.setItem("kept", "1");
    await Promise.resolve();
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({ kept: "1", draft: "hello, world" }, [
      ["draft", "hello, world"],
      ["gone", null],
    ]);
  });

  it("reports nothing when nothing changed", async () => {
    const report = vi.fn();
    const storage = createTabStorage({ kept: "1" }, report);
    storage.setItem("kept", "1");
    storage.removeItem("absent");
    await Promise.resolve();
    expect(report).not.toHaveBeenCalled();
  });
});

describe("createDeferredStorage", () => {
  it("writes at once, with no unload to flush it", () => {
    const base = createMemoryStorage();
    const deferred = createDeferredStorage(base, (value: { text: string }) => value.text);
    deferred.setItem("composer", { text: "typed just before the tab hid" });
    expect(base.getItem("composer")).toBe("typed just before the tab hid");
  });
});
