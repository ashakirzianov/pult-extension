import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as vscode from "vscode";

import type { BoundEnvironment } from "../connection/presentation.ts";
import type { WindowConnection } from "../connection/service.ts";
import type { ProjectFavicons } from "./favicons.ts";
import type { ThreadsModel } from "./model.ts";
import { nextWake, type Shelves, shelve, threadDescription, threadStatus } from "./presentation.ts";
import { parseThreadUri, threadUri } from "./uri.ts";

type ShelfName = keyof Shelves;
type FoldedShelf = "snoozed" | "settled";

export type PickerNode =
  | { readonly kind: "thread"; readonly thread: EnvironmentThreadShell; readonly shelf: ShelfName }
  | { readonly kind: "shelf"; readonly shelf: FoldedShelf; readonly count: number };

const SHELF_LABELS: Record<FoldedShelf, string> = { snoozed: "Snoozed", settled: "Settled" };
const EXPANDED_KEY = "pult.picker.expanded";
const MINUTE_MS = 60_000;

/** The `vscode.Uri` of a thread's tab, whose decorations the picker's row shares. */
export function threadTabUri(environmentId: string, thread: EnvironmentThreadShell): vscode.Uri {
  return vscode.Uri.from(threadUri(environmentId, thread.id, thread.title));
}

/**
 * `pult.threads`, modelled on upstream's sidebar (`DECISIONS.md`,
 * `thread-picker`): pinned threads, then active ones, then the Snoozed and
 * Settled shelves, collapsed until opened and remembered per window. A row's
 * icon is its project's, its badge its status, its description the status
 * label or the shelf's time; it follows the active thread tab.
 */
export function threadPicker(input: {
  readonly connection: WindowConnection;
  readonly model: ThreadsModel;
  readonly favicons: ProjectFavicons;
  readonly workspaceState: vscode.Memento;
}): vscode.Disposable {
  const { connection, model, favicons, workspaceState } = input;
  const changes = new vscode.EventEmitter<PickerNode | undefined>();
  let shelves: Shelves = { pinned: [], active: [], snoozed: [], settled: [] };
  let nodes = new Map<string, PickerNode>();
  let shelfNodes: Array<PickerNode> = [];
  let now = new Date().toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expanded = () => workspaceState.get<ReadonlyArray<FoldedShelf>>(EXPANDED_KEY, []);
  const setExpanded = (shelf: FoldedShelf, open: boolean) =>
    workspaceState.update(EXPANDED_KEY, [
      ...expanded().filter((each) => each !== shelf),
      ...(open ? [shelf] : []),
    ]);

  const rebuild = () => {
    now = new Date().toISOString();
    shelves = shelve(model.threads(), now, model.features);
    nodes = new Map();
    for (const shelf of ["pinned", "active", "snoozed", "settled"] as const) {
      for (const thread of shelves[shelf]) nodes.set(thread.id, { kind: "thread", thread, shelf });
    }
    shelfNodes = (["snoozed", "settled"] as const)
      .filter((shelf) => shelves[shelf].length > 0)
      .map((shelf) => ({ kind: "shelf", shelf, count: shelves[shelf].length }));
    // Wake countdowns and settled times read in minutes; a snooze ends on its own.
    clearTimeout(timer);
    timer = undefined;
    if (shelfNodes.length > 0) {
      const wake = nextWake(shelves);
      const delay = Math.min(MINUTE_MS, wake === null ? MINUTE_MS : wake - Date.now() + 1);
      timer = setTimeout(update, Math.max(1_000, delay));
    }
  };

  const environmentId = () => model.environmentId ?? "";

  const view = vscode.window.createTreeView<PickerNode>("pult.threads", {
    treeDataProvider: {
      onDidChangeTreeData: changes.event,
      getChildren: (node) => {
        if (node === undefined) {
          return [
            ...[...shelves.pinned, ...shelves.active].map((thread) => nodes.get(thread.id)!),
            ...shelfNodes,
          ];
        }
        return node.kind === "shelf"
          ? shelves[node.shelf].map((thread) => nodes.get(thread.id)!)
          : [];
      },
      getParent: (node) =>
        node.kind === "thread" && (node.shelf === "snoozed" || node.shelf === "settled")
          ? shelfNodes.find((each) => each.kind === "shelf" && each.shelf === node.shelf)
          : undefined,
      getTreeItem: (node) =>
        node.kind === "shelf"
          ? shelfItem(node.shelf, node.count, expanded().includes(node.shelf))
          : threadItem(node.thread, node.shelf),
    },
  });

  const threadItem = (thread: EnvironmentThreadShell, shelf: ShelfName) => {
    const item = new vscode.TreeItem(thread.title, vscode.TreeItemCollapsibleState.None);
    item.id = `thread/${thread.id}`;
    item.resourceUri = threadTabUri(environmentId(), thread);
    const project = model.project(thread.projectId);
    if (project !== undefined) item.iconPath = favicons.icon(project);
    item.description = threadDescription(thread, shelf, now);
    item.tooltip = threadTooltip(thread, project?.title);
    item.contextValue = `thread-${shelf}`;
    item.command = { title: "Open", command: "pult.openThread", arguments: [item.resourceUri] };
    return item;
  };

  const message = (environment: BoundEnvironment | null): string => {
    if (environment === null) return "";
    if (environment.phase === "blocked") {
      return environment.error ?? `${environment.label} refused the connection.`;
    }
    if (!model.loaded) {
      return environment.phase === "offline" ? "Offline." : `Connecting to ${environment.label}…`;
    }
    return nodes.size === 0 ? `${environment.label} has no threads yet.` : "";
  };

  const update = () => {
    rebuild();
    const environment = connection.environment;
    view.description = environment?.label ?? "";
    view.message = message(environment);
    changes.fire(undefined);
  };

  /** Selects the active tab's thread, when the picker is open to show it. */
  const revealActive = () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!view.visible || !(input instanceof vscode.TabInputCustom)) return;
    const resource = parseThreadUri(input.uri);
    if (resource?.target.kind !== "thread") return;
    const node = nodes.get(resource.target.threadId);
    if (node !== undefined) void view.reveal(node, { select: true, focus: false });
  };

  update();
  return vscode.Disposable.from(
    view,
    changes,
    model.onDidChange(update),
    favicons.onDidChange(() => changes.fire(undefined)),
    connection.onDidChange(() => {
      view.description = connection.environment?.label ?? "";
      view.message = message(connection.environment);
    }),
    view.onDidExpandElement(({ element }) => {
      if (element.kind === "shelf") void setExpanded(element.shelf, true);
    }),
    view.onDidCollapseElement(({ element }) => {
      if (element.kind === "shelf") void setExpanded(element.shelf, false);
    }),
    vscode.window.tabGroups.onDidChangeTabs(revealActive),
    vscode.window.tabGroups.onDidChangeTabGroups(revealActive),
    view.onDidChangeVisibility(revealActive),
    { dispose: () => clearTimeout(timer) },
  );
}

function shelfItem(shelf: FoldedShelf, count: number, open: boolean): vscode.TreeItem {
  const item = new vscode.TreeItem(
    SHELF_LABELS[shelf],
    open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = `shelf/${shelf}`;
  item.description = String(count);
  item.iconPath = new vscode.ThemeIcon(shelf === "snoozed" ? "clock" : "pass");
  item.contextValue = `shelf-${shelf}`;
  return item;
}

/** The row's hover: its project, status, and where its work lives. */
function threadTooltip(
  thread: EnvironmentThreadShell,
  projectTitle: string | undefined,
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${escapeMarkdown(thread.title)}**\n\n`);
  const lines = [
    projectTitle === undefined ? null : `Project: ${projectTitle}`,
    threadStatus(thread)?.label ?? null,
    thread.worktreePath === null ? null : `Worktree: \`${thread.worktreePath}\``,
    thread.branch === null ? null : `Branch: \`${thread.branch}\``,
    pullRequestLine(thread),
  ].filter((line) => line !== null);
  tooltip.appendMarkdown(lines.map((line) => line.replaceAll("\n", " ")).join("  \n"));
  return tooltip;
}

function pullRequestLine(thread: EnvironmentThreadShell): string | null {
  const pullRequest = thread.linkedPullRequest ?? thread.branchPullRequest ?? null;
  if (pullRequest !== null) {
    return `Pull request: [#${pullRequest.number}](${pullRequest.url})`;
  }
  const count = thread.pullRequests.length;
  return count === 0 ? null : `${count} pull request${count === 1 ? "" : "s"}`;
}

function escapeMarkdown(text: string): string {
  return text.replaceAll(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

/** The thread a picker row or a tab's URI names, for commands that take either. */
export function threadFromArgument(
  model: ThreadsModel,
  argument: unknown,
): EnvironmentThreadShell | undefined {
  if (argument instanceof vscode.Uri) {
    const resource = parseThreadUri(argument);
    return resource?.target.kind === "thread" && resource.environmentId === model.environmentId
      ? model.thread(resource.target.threadId)
      : undefined;
  }
  if (typeof argument === "object" && argument !== null && "kind" in argument) {
    const node = argument as PickerNode;
    return node.kind === "thread" ? model.thread(node.thread.id) : undefined;
  }
  return undefined;
}
