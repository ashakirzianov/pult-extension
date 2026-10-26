import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
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
 * active, snoozed, settled, each in its shelf's order, and nothing unlisted.
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
      threads: shelvedThreads(model, now).map(([thread, shelf]) => ({
        id: thread.id,
        shelf,
        projectId: thread.projectId,
        projectName: model.project(thread.projectId)?.title ?? thread.projectId,
        projectRoot: model.project(thread.projectId)?.workspaceRoot ?? null,
        title: thread.title,
        branch: thread.branch,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        working: threadStatus(thread, now)?.badge === "R",
        pinned: thread.pinnedAt !== null,
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

function shelvedThreads(model: ThreadsModel, now: string): Array<[EnvironmentThreadShell, ShelfName]> {
  const shelves = shelve(model.threads(), now, model.features);
  const names: ReadonlyArray<ShelfName> = ["pinned", "active", "snoozed", "settled"];
  return names.flatMap((shelf) => shelves[shelf].map((thread): [EnvironmentThreadShell, ShelfName] => [thread, shelf]));
}
