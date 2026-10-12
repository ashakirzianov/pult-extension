// How the picker and tabs present threads, after upstream's sidebar
// (`webview/t3/src/components/Sidebar.tsx` and `Sidebar.logic.ts`, which the
// host bundle cannot import): its shelves and their order, its status set as a
// letter badge, its status label text, and the times its shelves show.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed, snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import {
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

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
 * Upstream's shelves: snooze wins until its wake time, then settlement wins
 * over a stale pin. Pinned and active follow their arranged order, snoozed the
 * soonest wake, settled the newest settlement.
 */
export function shelve(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: string,
  features: ThreadFeatures,
): Shelves {
  const pinned: Array<EnvironmentThreadShell> = [];
  const active: Array<EnvironmentThreadShell> = [];
  const snoozed: Array<EnvironmentThreadShell> = [];
  const settled: Array<EnvironmentThreadShell> = [];
  for (const thread of threads) {
    if (!isListed(thread)) continue;
    if (features.snooze && effectiveSnoozed(thread, { now })) snoozed.push(thread);
    else if (features.settlement && thread.settledOverride === "settled") settled.push(thread);
    else if (thread.pinnedAt !== null) pinned.push(thread);
    else active.push(thread);
  }
  const wakeMs = (thread: EnvironmentThreadShell) => Date.parse(thread.snoozedUntil ?? "") || 0;
  return {
    pinned: sortPinnedThreadsByOrderKey(pinned),
    active: sortActiveThreadsByOrderKey(active),
    snoozed: snoozed.toSorted((left, right) => wakeMs(left) - wakeMs(right)),
    settled: sortSettledThreads(settled),
  };
}

/** The next time a snoozed thread wakes, when the shelves change by themselves. */
export function nextWake(shelves: Shelves): number | null {
  const wakes = shelves.snoozed
    .map((thread) => Date.parse(thread.snoozedUntil ?? ""))
    .filter((ms) => !Number.isNaN(ms));
  return wakes.length === 0 ? null : Math.min(...wakes);
}

/** R running, W waiting on you, Q queued, F failed; the colours are `package.json`'s. */
export type StatusBadge = "R" | "W" | "Q" | "F";

export interface ThreadStatus {
  /** Upstream's label for the status, as its sidebar shows it. */
  readonly label: string;
  readonly badge: StatusBadge | null;
}

/** Upstream's status pill, with its failure states, mapped onto a badge. */
export function threadStatus(thread: EnvironmentThreadShell): ThreadStatus | null {
  if (thread.hasPendingApprovals) return { label: "Pending Approval", badge: "W" };
  if (thread.hasPendingUserInput) return { label: "Awaiting Input", badge: "W" };
  const runtime = thread.runtime?.status;
  if (runtime === "running" || runtime === "waiting") return { label: "Working", badge: "R" };
  if (runtime === "preparing" || runtime === "starting" || runtime === "queued") {
    return { label: "Connecting", badge: "Q" };
  }
  if (runtime === "failed") {
    return thread.runtime?.lastErrorClass === "usage_limit"
      ? { label: "Usage Limit", badge: "F" }
      : { label: "Failed", badge: "F" };
  }
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks)) {
    return { label: "Waiting", badge: "R" };
  }
  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    !threadRuntimeIsActive(thread.runtime)
  ) {
    return { label: "Plan Ready", badge: "W" };
  }
  if (hasUnseenCompletion(thread)) return { label: "Completed", badge: null };
  return null;
}

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
  shelf: keyof Shelves,
  now: string,
): string {
  if (shelf === "snoozed" && thread.snoozedUntil !== null) {
    return `wakes in ${snoozeWakeLabel(thread.snoozedUntil, { now })}`;
  }
  if (shelf === "settled") {
    const settledAt = resolveSettledThreadTimestamp(thread);
    return settledAt === null ? "" : ago(settledAt, now);
  }
  return threadStatus(thread)?.label ?? "";
}
