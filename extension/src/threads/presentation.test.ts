import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2ThreadShell } from "../../../vendor/t3code/packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  ago,
  nextWake,
  NO_THREAD_FEATURES,
  shelve,
  threadDescription,
  threadStatus,
} from "./presentation.ts";

const NOW = "2026-06-20T12:00:00.000Z";
const ALL = { settlement: true, snooze: true, pinning: true };
const at = (iso: string) => DateTime.makeUnsafe(iso);

function thread(id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) {
  return presentThreadShell(EnvironmentId.make("env"), {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    ...overrides,
  });
}

const ids = (threads: ReadonlyArray<{ readonly id: string }>) => threads.map((each) => each.id);

describe("shelve", () => {
  it("puts a thread on one shelf: snoozed, then settled, then pinned, then active", () => {
    const shelves = shelve(
      [
        thread("snoozed-settled-pinned", {
          snoozedUntil: at("2026-06-20T15:00:00.000Z"),
          settledOverride: "settled",
          pinnedAt: at("2026-06-19T00:00:00.000Z"),
        }),
        thread("settled-pinned", {
          settledOverride: "settled",
          pinnedAt: at("2026-06-19T00:00:00.000Z"),
        }),
        thread("pinned", { pinnedAt: at("2026-06-19T00:00:00.000Z") }),
        thread("woken", { snoozedUntil: at("2026-06-20T11:00:00.000Z") }),
      ],
      NOW,
      ALL,
    );
    expect(ids(shelves.snoozed)).toEqual(["snoozed-settled-pinned"]);
    expect(ids(shelves.settled)).toEqual(["settled-pinned"]);
    expect(ids(shelves.pinned)).toEqual(["pinned"]);
    expect(ids(shelves.active)).toEqual(["woken"]);
  });

  it("keeps every thread off the shelves a server does not advertise", () => {
    const shelves = shelve(
      [
        thread("snoozed", { snoozedUntil: at("2026-06-20T15:00:00.000Z") }),
        thread("settled", { settledOverride: "settled" }),
      ],
      NOW,
      NO_THREAD_FEATURES,
    );
    expect(ids(shelves.active).toSorted()).toEqual(["settled", "snoozed"]);
    expect([...shelves.snoozed, ...shelves.settled]).toEqual([]);
  });

  it("leaves out archived, deleted and subagent threads", () => {
    const shelves = shelve(
      [
        thread("archived", { archivedAt: at(NOW) }),
        thread("deleted", { deletedAt: at(NOW) }),
        thread("subagent", {
          lineage: {
            rootThreadId: ThreadId.make("root"),
            parentThreadId: ThreadId.make("root"),
            relationshipToParent: "subagent",
          },
        }),
      ],
      NOW,
      ALL,
    );
    expect([shelves.pinned, shelves.active, shelves.snoozed, shelves.settled].flat()).toEqual([]);
  });

  it("orders pins by their arranged keys and snoozes by the soonest wake", () => {
    const pinnedAt = at("2026-06-19T00:00:00.000Z");
    const shelves = shelve(
      [
        thread("pin-b", { pinnedAt, pinOrderKey: "b" }),
        thread("pin-a", { pinnedAt, pinOrderKey: "a" }),
        thread("wakes-later", { snoozedUntil: at("2026-06-21T09:00:00.000Z") }),
        thread("wakes-sooner", { snoozedUntil: at("2026-06-20T13:00:00.000Z") }),
      ],
      NOW,
      ALL,
    );
    expect(ids(shelves.pinned)).toEqual(["pin-a", "pin-b"]);
    expect(ids(shelves.snoozed)).toEqual(["wakes-sooner", "wakes-later"]);
    expect(nextWake(shelves)).toBe(Date.parse("2026-06-20T13:00:00.000Z"));
  });
});

describe("threadStatus", () => {
  const request = (kind: "command" | "user_input") => ({
    id: RuntimeRequestId.make("request"),
    kind,
    createdAt: at(NOW),
  });
  const running = (status: OrchestrationV2ThreadShell["status"]) => ({
    latestRunId: RunId.make("run"),
    activeRunId: RunId.make("run"),
    status,
  });

  it("badges what waits on the user W, ahead of a running agent", () => {
    expect(
      threadStatus(
        thread("t", { ...running("running"), pendingRuntimeRequest: request("command") }),
      ),
    ).toEqual({ label: "Pending Approval", badge: "W" });
    expect(threadStatus(thread("t", { pendingRuntimeRequest: request("user_input") }))).toEqual({
      label: "Awaiting Input",
      badge: "W",
    });
  });

  it("badges a running agent R, a queued one Q and a failed one F", () => {
    expect(threadStatus(thread("t", running("running")))).toEqual({ label: "Working", badge: "R" });
    expect(threadStatus(thread("t", running("queued")))).toEqual({
      label: "Connecting",
      badge: "Q",
    });
    expect(threadStatus(thread("t", running("failed")))).toEqual({ label: "Failed", badge: "F" });
    expect(
      threadStatus(thread("t", { ...running("failed"), lastErrorClass: "usage_limit" })),
    ).toEqual({ label: "Usage Limit", badge: "F" });
  });

  it("labels an unseen completion without a badge, and a seen one not at all", () => {
    const completed = {
      latestRunId: RunId.make("run"),
      status: "completed" as const,
      latestRunCompletedAt: at("2026-06-20T11:00:00.000Z"),
    };
    expect(
      threadStatus(thread("t", { ...completed, lastVisitedAt: at("2026-06-20T10:00:00.000Z") })),
    ).toEqual({ label: "Completed", badge: null });
    expect(
      threadStatus(thread("t", { ...completed, lastVisitedAt: at("2026-06-20T11:30:00.000Z") })),
    ).toBeNull();
  });
});

describe("threadDescription", () => {
  it("counts down a snooze and dates a settlement", () => {
    expect(
      threadDescription(
        thread("t", { snoozedUntil: at("2026-06-20T14:00:00.000Z") }),
        "snoozed",
        NOW,
      ),
    ).toBe("wakes in 2h");
    expect(
      threadDescription(
        thread("t", { settledOverride: "settled", settledAt: at("2026-06-20T09:00:00.000Z") }),
        "settled",
        NOW,
      ),
    ).toBe("3h");
  });

  it("states how long ago in compact units", () => {
    expect(ago("2026-06-20T11:59:30.000Z", NOW)).toBe("now");
    expect(ago("2026-06-20T11:55:00.000Z", NOW)).toBe("5m");
    expect(ago("2026-06-18T12:00:00.000Z", NOW)).toBe("2d");
    expect(ago("2026-05-30T12:00:00.000Z", NOW)).toBe("3w");
  });
});
