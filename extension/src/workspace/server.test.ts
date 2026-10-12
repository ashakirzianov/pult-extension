import { assert, describe, it } from "@effect/vitest";
import { ProjectWatchEntriesError, type ProjectWatchEntriesEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { watchSession } from "./server.ts";

const CWD = "/repo";
const EVENT: ProjectWatchEntriesEvent = {
  changes: [{ path: "a.ts", kind: "changed" }],
  truncated: false,
};

/** The subscription's attempts, each failing with `failures` in turn and then yielding EVENT. */
function subscription(failures: ReadonlyArray<ProjectWatchEntriesError["failure"]>) {
  let attempt = 0;
  return Stream.suspend(() => {
    const failure = failures[attempt++];
    return failure === undefined
      ? Stream.make(EVENT)
      : Stream.fail(new ProjectWatchEntriesError({ cwd: CWD, failure }));
  });
}

describe("watchSession", () => {
  it.effect("subscribes again a second after a failure", () =>
    Effect.gen(function* () {
      const items = yield* watchSession(subscription(["search_index_scan_timed_out"])).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 second");
      const tags = Array.from(yield* Fiber.join(items), (item) => item._tag);
      assert.deepStrictEqual(tags, ["subscribed", "subscribed", "changed"]);
    }),
  );

  it.effect("reports a root found gone", () =>
    Effect.gen(function* () {
      const items = yield* watchSession(subscription(["workspace_root_not_found"])).pipe(
        Stream.take(2),
        Stream.runCollect,
      );
      const tags = Array.from(items, (item) => item._tag);
      assert.deepStrictEqual(tags, ["subscribed", "gone"]);
    }),
  );
});
