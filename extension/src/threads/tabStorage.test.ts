import { describe, expect, it } from "vite-plus/test";

import { applyChanges, CarriedStorage } from "./tabStorage.ts";

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
