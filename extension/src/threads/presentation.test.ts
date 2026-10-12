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
  tabMenuContext,
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
    expect(nextWake(shelves.snoozed, Date.parse(NOW))).toBe(Date.parse("2026-06-20T13:00:00.000Z"));
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
  const completed = {
    latestRunId: RunId.make("run"),
    status: "completed" as const,
    latestRunCompletedAt: at("2026-06-20T11:00:00.000Z"),
  };
  const status = (overrides: Partial<OrchestrationV2ThreadShell>) =>
    threadStatus(thread("t", overrides), NOW);

  it("badges what waits on the user W, ahead of a running agent", () => {
    expect(status({ ...running("running"), pendingRuntimeRequest: request("command") })).toEqual({
      label: "Approval",
      badge: "W",
    });
    expect(status({ pendingRuntimeRequest: request("user_input") })).toEqual({
      label: "Input",
      badge: "W",
    });
  });

  it("badges an agent at work R, queued or running, and a failed one F", () => {
    expect(status(running("running"))).toEqual({ label: "Working", badge: "R" });
    expect(status(running("queued"))).toEqual({ label: "Working", badge: "R" });
    expect(status(running("failed"))).toEqual({ label: "Failed", badge: "F" });
    expect(status({ ...running("failed"), lastErrorClass: "usage_limit" })).toEqual({
      label: "Limited",
      badge: "F",
    });
  });

  it("shows Plan Ready only once the plan's run has settled", () => {
    const plan = { interactionMode: "plan" as const, hasActionableProposedPlan: true };
    expect(status({ ...plan, ...completed, lastVisitedAt: at(NOW) })).toEqual({
      label: "Plan Ready",
      badge: "W",
    });
    expect(status({ ...plan, ...running("running") })?.label).toBe("Working");
    // Completed, but still the runtime's active run: not settled yet.
    expect(
      status({ ...plan, ...completed, activeRunId: RunId.make("run"), lastVisitedAt: at(NOW) }),
    ).toBeNull();
  });

  it("shows a snooze that ended Woke until the thread is visited or settled", () => {
    const woken = {
      snoozedAt: at("2026-06-20T09:00:00.000Z"),
      snoozedUntil: at("2026-06-20T11:30:00.000Z"),
    };
    expect(status({ ...woken, lastVisitedAt: at("2026-06-20T10:00:00.000Z") })).toEqual({
      label: "Woke",
      badge: "W",
    });
    expect(status({ ...woken, lastVisitedAt: at("2026-06-20T11:45:00.000Z") })).toBeNull();
    expect(status({ ...woken, settledOverride: "settled" })).toBeNull();
    expect(status({ ...woken, snoozedUntil: at("2026-06-20T13:00:00.000Z") })).toBeNull();
  });

  it("labels an unseen completion Done without a badge, and a seen one not at all", () => {
    expect(status({ ...completed, lastVisitedAt: at("2026-06-20T10:00:00.000Z") })).toEqual({
      label: "Done",
      badge: null,
    });
    expect(status({ ...completed, lastVisitedAt: at("2026-06-20T11:30:00.000Z") })).toBeNull();
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

describe("tabMenuContext", () => {
  const uri = (path: string, query = "") => ({
    scheme: "pult-thread",
    authority: "env",
    path,
    query,
    toString: () => `pult-thread://env${path}`,
  });
  const threads = new Map(
    [
      thread("pinned", { pinnedAt: at("2026-06-19T00:00:00.000Z") }),
      thread("snoozed", { snoozedUntil: at("2026-06-20T15:00:00.000Z") }),
      thread("settled", { settledOverride: "settled" }),
      thread("active"),
    ].map((each) => [each.id as string, each]),
  );
  const context = (active: ReturnType<typeof uri> | undefined) =>
    tabMenuContext({
      tabs: [
        uri("/pinned/A title"),
        uri("/snoozed/A title"),
        uri("/settled/A title"),
        uri("/active/A title"),
        uri("/active/A title in another group"),
        uri("/draft/d/New Thread", "project=p"),
        uri("/gone/A title"),
      ],
      active,
      environmentId: "env",
      thread: (threadId) => threads.get(threadId),
      now: NOW,
      features: ALL,
    });

  it("files each open tab of a known thread under its thread's shelf", () => {
    expect(context(undefined).tabs).toEqual({
      all: [
        "pult-thread://env/pinned/A title",
        "pult-thread://env/snoozed/A title",
        "pult-thread://env/settled/A title",
        "pult-thread://env/active/A title",
        "pult-thread://env/active/A title in another group",
      ],
      pinned: ["pult-thread://env/pinned/A title"],
      active: [
        "pult-thread://env/active/A title",
        "pult-thread://env/active/A title in another group",
      ],
      snoozed: ["pult-thread://env/snoozed/A title"],
      settled: ["pult-thread://env/settled/A title"],
    });
  });

  it("names the active tab's shelf for the palette, and none for a draft", () => {
    expect(context(uri("/settled/A title")).activeShelf).toBe("settled");
    expect(context(uri("/draft/d/New Thread", "project=p")).activeShelf).toBeNull();
  });
});
