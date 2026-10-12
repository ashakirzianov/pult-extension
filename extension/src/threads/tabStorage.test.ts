import { describe, expect, it } from "vite-plus/test";

import { applyChanges, CarriedStorage, fillShare, shareChanges } from "./tabStorage.ts";

describe("applyChanges", () => {
  it("sets and removes keys in order", () => {
    expect(
      applyChanges({ a: "1", b: "2" }, [
        ["a", "3"],
        ["b", null],
        ["c", "4"],
      ]),
    ).toEqual({ a: "3", c: "4" });
  });
});

describe("CarriedStorage", () => {
  it("gives each of a thread's tabs reopened at one URI its own storage, by group", () => {
    const carried = new CarriedStorage();
    carried.put("pult-thread://env/t/Title", 1, { draft: "left" });
    carried.put("pult-thread://env/t/Title", 2, { draft: "right" });
    expect(carried.take("pult-thread://env/t/Title", 2)).toEqual({ draft: "right" });
    expect(carried.take("pult-thread://env/t/Title", 1)).toEqual({ draft: "left" });
    expect(carried.take("pult-thread://env/t/Title", 1)).toBeNull();
  });

  it("drops storage no tab took", () => {
    const carried = new CarriedStorage();
    const drop = carried.put("pult-thread://env/t/Title", 1, { draft: "left" });
    drop();
    expect(carried.take("pult-thread://env/t/Title", 1)).toBeNull();
  });
});

describe("the window's share", () => {
  const composer = (state: object) => JSON.stringify({ state, version: 9 });
  const sticky = {
    stickyModelSelectionByProvider: { codex: { instanceId: "codex", model: "gpt-5" } },
    stickyActiveProvider: "codex",
  };

  it("takes a tab's settings and remembered model, not its drafts", () => {
    const shared = shareChanges({}, [
      ["t3code:client-settings:v1", '{"timestampFormat":"24-hour"}'],
      [
        "t3code:composer-drafts:v1",
        composer({ draftsByThreadKey: { "env:thread": { prompt: "mine" } }, ...sticky }),
      ],
      ["pult:draft:tab-1", "draft-1"],
    ]);
    expect(shared).toEqual({
      "t3code:client-settings:v1": '{"timestampFormat":"24-hour"}',
      "t3code:composer-drafts:v1": composer(sticky),
    });
  });

  it("keeps the remembered model when a tab's composer store goes, and its object when nothing changed", () => {
    const shared = { "t3code:composer-drafts:v1": composer(sticky) };
    expect(shareChanges(shared, [["t3code:composer-drafts:v1", null]])).toBe(shared);
    expect(
      shareChanges(shared, [
        ["t3code:composer-drafts:v1", composer({ ...sticky, draftsByThreadKey: {} })],
      ]),
    ).toBe(shared);
    expect(shareChanges({ a: "1" }, [["a", null]])).toEqual({});
  });

  it("fills only what it lacks from a tab's saved storage", () => {
    expect(fillShare({ a: "window" }, { a: "tab", b: "tab", "pult:draft:x": "y" })).toEqual({
      a: "window",
      b: "tab",
    });
  });
});
