import { type EnvironmentThreadShell, resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import * as vscode from "vscode";

import type { WindowConnection } from "./connection/service.ts";
import type { ThreadsModel } from "./threads/model.ts";
import { shelve, threadStatus, type ShelfName } from "./threads/presentation.ts";

/**
 * The spike's bridge to Pult's own shell (`pult` repo, branch `shell`): the
 * thread model, pushed into the page with a command the shell registers below
 * the extension API, so a thread pane the shell renders in-process can show
 * it. Only in the shell: elsewhere the command does not exist and nothing is
 * sent. The shell's command and payload shape are its `src/threads/store.ts`.
 * The threads go shelved as upstream's sidebar lists them (`shelve`): pinned,
 * active, snoozed, settled, each in its shelf's order; then the subagents,
 * which upstream lists in their parent and the shell under the parent's card,
 * on no shelf, with their parent and root. Archived and deleted ones go
 * nowhere.
 */
export function shellBridge(connection: WindowConnection, model: ThreadsModel): vscode.Disposable {
  if (vscode.env.appName !== "Pult") return { dispose: () => {} };
  const push = () => {
    const environment = connection.environment;
    const now = new Date().toISOString();
    const payload = {
      environment:
        environment === null
          ? null
          : { id: environment.environmentId, label: environment.label, phase: environment.phase },
      // What the server lets the shell do to a thread: settle, snooze, pin.
      features: model.features,
      threads: shelvedThreads(model, now).map(([thread, shelf]) => ({
        id: thread.id,
        shelf,
        parentId: thread.lineage.parentThreadId,
        rootId: thread.lineage.rootThreadId,
        projectId: thread.projectId,
        projectName: model.project(thread.projectId)?.title ?? thread.projectId,
        projectRoot: model.project(thread.projectId)?.workspaceRoot ?? null,
        projectIcon: model.project(thread.projectId)?.projectIcon ?? null,
        title: thread.title,
        branch: thread.branch,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        working: threadStatus(thread, now)?.badge === "R",
        // Upstream's Waiting: stopped, its run held open by background work that will wake it.
        waiting: thread.runtime?.status === "idle",
        workingSince: resolveThreadWorkingStartedAt(thread),
        pinned: thread.pinnedAt !== null,
        // No pending approval or input and no queued turn start, as of this push.
        canSnooze: canSnooze(thread, { now }),
        latestRun:
          thread.latestRun === null
            ? null
            : {
                status: thread.latestRun.status,
                startedAt: thread.latestRun.startedAt,
                finishedAt: thread.latestRun.completedAt,
              },
        goal: thread.goal?.objective ?? null,
      })),
    };
    vscode.commands
      .executeCommand("pult-shell.threads", payload)
      .then(undefined, (error: unknown) => {
        console.warn("[pult] shell bridge push failed", error);
      });
  };
  push();
  return vscode.Disposable.from(model.onDidChange(push), connection.onDidChange(push));
}

function shelvedThreads(model: ThreadsModel, now: string): Array<[EnvironmentThreadShell, ShelfName | null]> {
  const threads = model.threads();
  const shelves = shelve(threads, now, model.features);
  const names: ReadonlyArray<ShelfName> = ["pinned", "active", "snoozed", "settled"];
  const subagents = threads.filter(
    (thread) =>
      thread.lineage.relationshipToParent === "subagent" &&
      thread.archivedAt === null &&
      thread.deletedAt === null,
  );
  return [
    ...names.flatMap((shelf) => shelves[shelf].map((thread): [EnvironmentThreadShell, ShelfName] => [thread, shelf])),
    ...subagents.map((thread): [EnvironmentThreadShell, null] => [thread, null]),
  ];
}
