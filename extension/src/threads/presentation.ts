// How the picker and tabs present threads, after upstream's shelved sidebar
// (`webview/t3/src/components/Sidebar.tsx` and `Sidebar.logic.ts`, which the
// host bundle cannot import): its shelves and their order, its row status as a
// letter badge and its label, and the times its shelves show.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  effectiveSnoozed,
  snoozeWakeLabel,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";

import { parseThreadUri, type UriComponents } from "./uri.ts";

/**
 * The thread features a server advertises (`DECISIONS.md`, `capability-gated-rpcs`).
 * Without settlement or snooze, as on a stock server, no thread sits on those
 * shelves and their commands are hidden, as upstream's sidebar does.
 */
export interface ThreadFeatures {
  readonly settlement: boolean;
  readonly snooze: boolean;
  readonly pinning: boolean;
}

export const NO_THREAD_FEATURES: ThreadFeatures = {
  settlement: false,
  snooze: false,
  pinning: false,
};

export type ShelfName = "pinned" | "active" | "snoozed" | "settled";

export interface Shelves {
  readonly pinned: ReadonlyArray<EnvironmentThreadShell>;
  readonly active: ReadonlyArray<EnvironmentThreadShell>;
  readonly snoozed: ReadonlyArray<EnvironmentThreadShell>;
  readonly settled: ReadonlyArray<EnvironmentThreadShell>;
}

/** Threads the sidebar lists: not archived or deleted, and no subagent's, which live in their parent. */
export function isListed(thread: EnvironmentThreadShell): boolean {
  return (
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.lineage.relationshipToParent !== "subagent"
  );
}

/**
 * Upstream's shelf for a thread: snooze wins until its wake time, then
 * settlement wins over a stale pin. Null for a thread the sidebar does not list.
 */
export function shelfOf(
  thread: EnvironmentThreadShell,
  now: string,
  features: ThreadFeatures,
): ShelfName | null {
  if (!isListed(thread)) return null;
  if (features.snooze && effectiveSnoozed(thread, { now })) return "snoozed";
  if (features.settlement && thread.settledOverride === "settled") return "settled";
  return thread.pinnedAt === null ? "active" : "pinned";
}

/**
 * The threads on upstream's shelves (`shelfOf`). Pinned and active follow their
 * arranged order, snoozed the soonest wake, settled the newest settlement.
 */
export function shelve(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: string,
  features: ThreadFeatures,
): Shelves {
  const shelves: Record<ShelfName, Array<EnvironmentThreadShell>> = {
    pinned: [],
    active: [],
    snoozed: [],
    settled: [],
  };
  for (const thread of threads) {
    const shelf = shelfOf(thread, now, features);
    if (shelf !== null) shelves[shelf].push(thread);
  }
  const { pinned, active, snoozed, settled } = shelves;
  const wakeMs = (thread: EnvironmentThreadShell) => Date.parse(thread.snoozedUntil ?? "") || 0;
  return {
    pinned: sortPinnedThreadsByOrderKey(pinned),
    active: sortActiveThreadsByOrderKey(active),
    snoozed: snoozed.toSorted((left, right) => wakeMs(left) - wakeMs(right)),
    settled: sortSettledThreads(settled),
  };
}

/** The next time one of `threads` wakes from its snooze, after `now`. */
export function nextWake(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: number,
): number | null {
  const wakes = threads
    .map((thread) => Date.parse(thread.snoozedUntil ?? ""))
    .filter((ms) => ms > now);
  return wakes.length === 0 ? null : Math.min(...wakes);
}

/**
 * R in motion, W waiting on you, F failed; the colours are `package.json`'s.
 * The sidebar's grey Waiting, an agent stopped with background work that will
 * wake it, is not the user's turn, and recedes as Working does: R.
 */
export type StatusBadge = "R" | "W" | "F";

export interface ThreadStatus {
  /** Upstream's label for the status, as its sidebar shows it. */
  readonly label: string;
  readonly badge: StatusBadge | null;
}

/**
 * The shelved sidebar's row status (the fork's `resolveSidebarThreadStatus`,
 * then the row's Woke and Done), with the older pill's Plan Ready between the
 * failures and Woke.
 */
export function threadStatus(thread: EnvironmentThreadShell, now: string): ThreadStatus | null {
  if (thread.hasPendingApprovals) return { label: "Approval", badge: "W" };
  if (thread.hasPendingUserInput) return { label: "Input", badge: "W" };
  switch (thread.runtime?.status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      // A native /goal keeps the agent going across turns until it is met.
      return { label: thread.goal?.status === "active" ? "Goal" : "Working", badge: "R" };
    case "idle":
      return { label: "Waiting", badge: "R" };
    case "failed":
      return thread.runtime.lastErrorClass === "usage_limit"
        ? { label: "Limited", badge: "F" }
        : { label: "Failed", badge: "F" };
  }
  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    isLatestRunSettled(thread)
  ) {
    return { label: "Plan Ready", badge: "W" };
  }
  if (isWoke(thread, now)) return { label: "Woke", badge: "W" };
  if (hasUnseenCompletion(thread)) return { label: "Done", badge: null };
  return null;
}

/** Upstream's `isLatestRunSettled` (`webview/t3/src/session-logic.ts`). */
function isLatestRunSettled({ latestRun, runtime }: EnvironmentThreadShell): boolean {
  if (latestRun === null) return false;
  switch (latestRun.status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return false;
  }
  return runtime?.activeRunId !== latestRun.runId;
}

/**
 * A snoozed thread that woke and has not been visited since; settling it
 * clears it. An unparseable visit counts as none, so it cannot eat the wake.
 */
function isWoke(thread: EnvironmentThreadShell, now: string): boolean {
  const wokeAt = Date.parse(threadWokeAt(thread, { now }) ?? "");
  if (Number.isNaN(wokeAt) || thread.settledOverride === "settled") return false;
  const visitedAt = Date.parse(thread.lastVisitedAt ?? "");
  return Number.isNaN(visitedAt) || visitedAt < wokeAt;
}

/** A run that completed since the last visit; a thread never visited counts as read. */
function hasUnseenCompletion(thread: EnvironmentThreadShell): boolean {
  const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
  if (Number.isNaN(completedAt) || !thread.lastVisitedAt) return false;
  const visitedAt = Date.parse(thread.lastVisitedAt);
  return Number.isNaN(visitedAt) || completedAt > visitedAt;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "now", "5m", "3h", "2d", "6w": how long ago, in the sidebar's compact units. */
export function ago(timestamp: string, now: string): string {
  const elapsed = Date.parse(now) - Date.parse(timestamp);
  if (Number.isNaN(elapsed) || elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  if (elapsed < 7 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d`;
  return `${Math.floor(elapsed / (7 * DAY_MS))}w`;
}

/** A row's description: its status label, or in the shelves, when it wakes or when it settled. */
export function threadDescription(
  thread: EnvironmentThreadShell,
  shelf: ShelfName,
  now: string,
): string {
  if (shelf === "snoozed" && thread.snoozedUntil !== null) {
    return `wakes in ${snoozeWakeLabel(thread.snoozedUntil, { now })}`;
  }
  if (shelf === "settled") {
    const settledAt = resolveSettledThreadTimestamp(thread);
    return settledAt === null ? "" : ago(settledAt, now);
  }
  return threadStatus(thread, now)?.label ?? "";
}

export interface TabMenuContext {
  /** Every open tab of a thread the model has, then those on each shelf, as URI strings. */
  readonly tabs: Readonly<Record<"all" | ShelfName, ReadonlyArray<string>>>;
  /** The shelf of the active tab's thread; null for a draft or any other tab. */
  readonly activeShelf: ShelfName | null;
}

/** What the menus' when clauses read of the open tabs (`TabMenuContext`). */
export function tabMenuContext(input: {
  readonly tabs: ReadonlyArray<UriComponents & { toString(): string }>;
  readonly active: UriComponents | undefined;
  readonly environmentId: string | null;
  readonly thread: (threadId: string) => EnvironmentThreadShell | undefined;
  readonly now: string;
  readonly features: ThreadFeatures;
}): TabMenuContext {
  const shelf = (uri: UriComponents) => {
    const resource = parseThreadUri(uri);
    if (resource?.target.kind !== "thread" || resource.environmentId !== input.environmentId) {
      return null;
    }
    const thread = input.thread(resource.target.threadId);
    return thread === undefined ? null : shelfOf(thread, input.now, input.features);
  };
  const tabs: Record<"all" | ShelfName, Array<string>> = {
    all: [],
    pinned: [],
    active: [],
    snoozed: [],
    settled: [],
  };
  for (const uri of input.tabs) {
    const tabShelf = shelf(uri);
    if (tabShelf === null) continue;
    tabs.all.push(uri.toString());
    tabs[tabShelf].push(uri.toString());
  }
  return { tabs, activeShelf: input.active === undefined ? null : shelf(input.active) };
}
