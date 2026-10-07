import type {
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as vscode from "vscode";

import type { BoundEnvironment } from "./connection/presentation.ts";
import type { WindowConnection } from "./connection/service.ts";

type Node =
  | { readonly kind: "project"; readonly project: OrchestrationProjectShell }
  | { readonly kind: "thread"; readonly thread: OrchestrationV2ThreadShell };

/**
 * `pult.threads`: the bound environment's projects and their active threads,
 * most recent first. The view's description is the environment's label, and its
 * message the connection while there is nothing to list.
 */
export function threadsView(connection: WindowConnection): vscode.Disposable {
  const changes = new vscode.EventEmitter<void>();
  const snapshot = () => Option.getOrUndefined(connection.environment?.shell ?? Option.none());
  const view = vscode.window.createTreeView<Node>("pult.threads", {
    treeDataProvider: {
      onDidChangeTreeData: changes.event,
      getChildren: (node) => {
        const shell = snapshot();
        if (shell === undefined) return [];
        if (node === undefined) return projects(shell);
        return node.kind === "project" ? threads(shell, node.project) : [];
      },
      getTreeItem: (node) =>
        node.kind === "project" ? projectItem(node.project) : threadItem(node.thread),
    },
  });
  const update = () => {
    const environment = connection.environment;
    view.description = environment?.label ?? "";
    view.message = (environment === null ? undefined : message(environment)) ?? "";
    changes.fire();
  };
  update();
  return vscode.Disposable.from(view, changes, connection.onDidChange(update));
}

function message(environment: BoundEnvironment): string | undefined {
  if (environment.phase === "blocked")
    return environment.error ?? `${environment.label} refused the connection.`;
  const shell = Option.getOrUndefined(environment.shell);
  if (shell === undefined) {
    return environment.phase === "offline" ? "Offline." : `Connecting to ${environment.label}…`;
  }
  return projects(shell).length === 0 ? `${environment.label} has no projects.` : undefined;
}

function projects(shell: OrchestrationV2ShellSnapshot): Array<Node> {
  return shell.projects
    .toSorted((left, right) => left.title.localeCompare(right.title))
    .map((project) => ({ kind: "project", project }));
}

function threads(
  shell: OrchestrationV2ShellSnapshot,
  project: OrchestrationProjectShell,
): Array<Node> {
  return shell.threads
    .filter((thread) => thread.projectId === project.id && thread.deletedAt === null)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    )
    .map((thread) => ({ kind: "thread", thread }));
}

function projectItem(project: OrchestrationProjectShell): vscode.TreeItem {
  const item = new vscode.TreeItem(project.title, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `project/${project.id}`;
  item.description = project.workspaceRoot;
  item.iconPath = new vscode.ThemeIcon("repo");
  return item;
}

function threadItem(thread: OrchestrationV2ThreadShell): vscode.TreeItem {
  const item = new vscode.TreeItem(thread.title, vscode.TreeItemCollapsibleState.None);
  item.id = `thread/${thread.id}`;
  if (thread.status !== "idle") item.description = thread.status;
  item.iconPath = new vscode.ThemeIcon("comment-discussion");
  return item;
}
