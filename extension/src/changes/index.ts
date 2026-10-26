import type { ReviewDiffPreviewSource, ReviewDiffPreviewSourceKind } from "@t3tools/contracts";
import * as vscode from "vscode";

import type { WindowBinding } from "../connection/catalog.ts";
import type { WindowConnection } from "../connection/service.ts";
import type { ThreadsModel } from "../threads/model.ts";
import { joinPath, PULT_SCHEME, toUriPath } from "../workspace/paths.ts";
import { type ChangeType, patchFiles } from "./patch.ts";
import { changesServer, type ChangesServer } from "./server.ts";

/** The scheme of a change's two sides, served by `ChangesView`'s content provider from the server's file contents RPC. */
const DIFF_SCHEME = "pult-diff";

/** A changed file of a source, with what the server's file contents RPC needs to show its sides. */
export interface Change {
  readonly cwd: string;
  readonly sourceKind: ReviewDiffPreviewSourceKind;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  /** Relative to `cwd`, after the change. */
  readonly path: string;
  readonly previousPath: string | null;
  readonly changeType: ChangeType;
  readonly additions: number;
  readonly deletions: number;
}

/** The content provider's query: a change and which of its sides. */
interface Side {
  readonly change: Change;
  readonly side: "old" | "new";
}

const GROUPS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly kind: ReviewDiffPreviewSourceKind }> = [
  { id: "changes", label: "Changes", kind: "branch-range" },
  { id: "working-tree", label: "Working Tree", kind: "working-tree" },
];

const BADGES: Record<ChangeType, { readonly badge: string; readonly color: string; readonly label: string }> = {
  change: { badge: "M", color: "gitDecoration.modifiedResourceForeground", label: "Modified" },
  new: { badge: "A", color: "gitDecoration.addedResourceForeground", label: "Added" },
  deleted: { badge: "D", color: "gitDecoration.deletedResourceForeground", label: "Deleted" },
  "rename-pure": { badge: "R", color: "gitDecoration.renamedResourceForeground", label: "Renamed" },
  "rename-changed": { badge: "R", color: "gitDecoration.renamedResourceForeground", label: "Renamed and modified" },
};

/**
 * The changes view: VS Code's Source Control view over the selected
 * thread's project, in place of upstream's diff panel (`pult/decisions`,
 * `view-right-panel`). One source control, for the thread's root, with the
 * server's two diff sources as its groups, Changes (the branch against its
 * base) and Working Tree; a resource opens VS Code's diff editor, its old
 * side from the server, its new side the live file, or the server's for a
 * deleted file or a committed change. The shell tells it the selected thread
 * (`pult.threadSelected`), asks it to show a change (`pult.showChanges`),
 * and it refreshes when the thread's latest run completes and on
 * `pult.refreshChanges`.
 */
class ChangesView implements vscode.TextDocumentContentProvider, vscode.FileDecorationProvider {
  private readonly server: ChangesServer;
  private readonly binding: WindowBinding;
  private readonly model: ThreadsModel;
  private sourceControl: { readonly control: vscode.SourceControl; readonly root: string; readonly groups: Map<string, vscode.SourceControlResourceGroup> } | undefined;
  private threadId: string | null = null;
  private completedAt: string | null | undefined;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private changes = new Map<string, Change>();
  private readonly contents = new Map<string, Promise<{ readonly oldContents: string; readonly newContents: string }>>();
  private failure: string | null = null;
  private readonly decorationChanges = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.decorationChanges.event;
  readonly disposables: vscode.Disposable[] = [];

  constructor(connection: WindowConnection, binding: WindowBinding, model: ThreadsModel) {
    this.server = changesServer(connection, binding);
    this.binding = binding;
    this.model = model;
    this.disposables.push(
      this.decorationChanges,
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this),
      vscode.window.registerFileDecorationProvider(this),
      vscode.commands.registerCommand("pult.threadSelected", (threadId: unknown) => this.select(typeof threadId === "string" ? threadId : null)),
      vscode.commands.registerCommand("pult.showChanges", (threadId: unknown, path: unknown) =>
        this.show(typeof threadId === "string" ? threadId : null, typeof path === "string" ? path : null),
      ),
      vscode.commands.registerCommand("pult.openChange", (change: Change) => this.open(change)),
      vscode.commands.registerCommand("pult.refreshChanges", () => this.refresh()),
      // For the console (`pult.exec("pult.changesState")`): what the view shows and why.
      vscode.commands.registerCommand("pult.changesState", () => ({
        threadId: this.threadId,
        root: this.sourceControl?.root ?? null,
        groups: Object.fromEntries([...(this.sourceControl?.groups ?? [])].map(([id, group]) => [id, group.resourceStates.length])),
        failure: this.failure,
      })),
      // The model may load after the selection, and a run's completion changes the files.
      model.onDidChange(() => {
        const completedAt = this.selectedThread()?.latestRun?.completedAt ?? null;
        const completed = completedAt !== this.completedAt;
        this.completedAt = completedAt;
        this.sync(completed);
      }),
      { dispose: () => this.sourceControl?.control.dispose() },
    );
    // In the shell, the selection made before this extension started.
    vscode.commands.executeCommand("pult-shell.selectedThread").then(
      (threadId) => this.select(typeof threadId === "string" ? threadId : null),
      () => undefined,
    );
  }

  private selectedThread() {
    return this.threadId === null ? undefined : this.model.thread(this.threadId);
  }

  /** The thread whose project the view shows; its root decides the source control. */
  select(threadId: string | null): void {
    this.threadId = threadId;
    this.completedAt = this.selectedThread()?.latestRun?.completedAt ?? null;
    this.sync(true);
  }

  /** The source control follows the selected thread's root as the model knows it; `refresh` reloads an unchanged one too. */
  private sync(refresh: boolean): void {
    const thread = this.selectedThread();
    const root = thread === undefined ? undefined : this.model.project(thread.projectId)?.workspaceRoot;
    if (root === undefined) {
      if (this.sourceControl === undefined) return;
      this.generation += 1;
      this.sourceControl.control.dispose();
      this.sourceControl = undefined;
      this.apply([]);
      return;
    }
    if (this.sourceControl?.root === root) {
      if (refresh) this.refresh();
      return;
    }
    this.sourceControl?.control.dispose();
    const control = vscode.scm.createSourceControl("pult", "Pult", this.uri(root));
    control.inputBox.visible = false;
    const groups = new Map<string, vscode.SourceControlResourceGroup>();
    for (const { id, label } of GROUPS) {
      const group = control.createResourceGroup(id, label);
      group.hideWhenEmpty = true;
      groups.set(id, group);
    }
    this.sourceControl = { control, root, groups };
    this.apply([]);
    this.refresh();
  }

  /** The Source Control view, with the change of `path` open when the view has it. */
  private async show(threadId: string | null, path: string | null): Promise<void> {
    if (threadId !== null) this.select(threadId);
    await vscode.commands.executeCommand("workbench.view.scm");
    if (path === null) return;
    await this.pending;
    const change = GROUPS.map((group) => this.changes.get(`${group.kind}:${path}`)).find((found) => found !== undefined);
    if (change !== undefined) await this.open(change);
  }

  /** The newest refresh wins; an older one's answer is dropped. */
  refresh(): void {
    const control = this.sourceControl;
    if (control === undefined) return;
    const generation = ++this.generation;
    this.pending = this.server.diffPreview({ cwd: control.root }).then(
      (preview) => {
        if (generation !== this.generation) return;
        this.failure = null;
        this.apply(preview.sources);
      },
      (error: unknown) => {
        // Not a repository, or a server without the review calls: no changes to show.
        if (generation !== this.generation) return;
        this.failure = error instanceof Error ? error.message : String(error);
        this.apply([]);
      },
    );
  }

  private apply(sources: ReadonlyArray<ReviewDiffPreviewSource>): void {
    const control = this.sourceControl;
    const previous = [...this.changes.values()].map((change) => this.fileUri(change));
    this.changes = new Map();
    this.contents.clear();
    if (control !== undefined) {
      for (const { id, kind } of GROUPS) {
        const source = sources.find((candidate) => candidate.kind === kind);
        const changes = source === undefined ? [] : changesOf(control.root, source);
        for (const change of changes) this.changes.set(`${kind}:${change.path}`, change);
        control.groups.get(id)!.resourceStates = changes.map((change) => this.resource(change));
      }
      // The badge counts files, not their appearances in both groups.
      control.control.count = new Set([...this.changes.values()].map((change) => change.path)).size;
    }
    this.decorationChanges.fire([...previous, ...[...this.changes.values()].map((change) => this.fileUri(change))]);
  }

  private resource(change: Change): vscode.SourceControlResourceState {
    const { label } = BADGES[change.changeType];
    return {
      resourceUri: this.fileUri(change),
      decorations: {
        strikeThrough: change.changeType === "deleted",
        tooltip: `${label}, +${change.additions} −${change.deletions}`,
      },
      command: { command: "pult.openChange", title: "Open Change", arguments: [change] },
    };
  }

  /** VS Code's diff editor on the change's two sides. */
  private async open(change: Change): Promise<void> {
    const live = change.sourceKind === "working-tree" && change.changeType !== "deleted";
    const title = `${change.path.split("/").at(-1)} (${GROUPS.find((group) => group.kind === change.sourceKind)?.label ?? "Changes"})`;
    await vscode.commands.executeCommand(
      "vscode.diff",
      this.sideUri(change, "old"),
      live ? this.fileUri(change) : this.sideUri(change, "new"),
      title,
      { preview: true },
    );
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { change, side } = JSON.parse(uri.query) as Side;
    const key = JSON.stringify([change.cwd, change.sourceKind, change.baseRef, change.headRef, change.previousPath, change.path]);
    let loading = this.contents.get(key);
    if (loading === undefined) {
      loading = this.server.diffFileContents({
        cwd: change.cwd,
        sourceKind: change.sourceKind,
        changeType: change.changeType,
        baseRef: change.baseRef,
        headRef: change.headRef,
        oldPath: change.previousPath ?? change.path,
        newPath: change.path,
      });
      this.contents.set(key, loading);
    }
    const contents = await loading;
    return side === "old" ? contents.oldContents : contents.newContents;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== PULT_SCHEME) return undefined;
    const change = [...this.changes.values()].find((candidate) => this.fileUri(candidate).path === uri.path);
    if (change === undefined) return undefined;
    const { badge, color, label } = BADGES[change.changeType];
    return { badge, color: new vscode.ThemeColor(color), tooltip: label, propagate: true };
  }

  private uri(hostPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: PULT_SCHEME, authority: this.binding.environmentId ?? "", path: toUriPath(hostPath) });
  }

  private fileUri(change: Change): vscode.Uri {
    return this.uri(joinPath(change.cwd, change.path));
  }

  private sideUri(change: Change, side: Side["side"]): vscode.Uri {
    return this.uri(joinPath(change.cwd, side === "old" ? (change.previousPath ?? change.path) : change.path)).with({
      scheme: DIFF_SCHEME,
      query: JSON.stringify({ change, side } satisfies Side),
    });
  }
}

/** A source's files as changes: its stats, with how each changed from its patch; a file the truncated patch missed counts as modified. */
function changesOf(cwd: string, source: ReviewDiffPreviewSource): Change[] {
  const parsed = new Map(patchFiles(source.diff).map((file) => [file.path, file]));
  const stats = source.files ?? [...parsed.values()].map((file) => ({ ...file, additions: 0, deletions: 0 }));
  return stats.map((stat) => {
    const file = parsed.get(stat.path);
    return {
      cwd,
      sourceKind: source.kind,
      baseRef: source.baseRef,
      headRef: source.headRef,
      path: stat.path,
      previousPath: file?.previousPath ?? stat.previousPath,
      changeType: file?.changeType ?? (stat.previousPath === null ? "change" : "rename-changed"),
      additions: stat.additions,
      deletions: stat.deletions,
    };
  });
}

export function registerChanges(input: {
  readonly connection: WindowConnection;
  readonly binding: WindowBinding;
  readonly model: ThreadsModel;
}): vscode.Disposable[] {
  return new ChangesView(input.connection, input.binding, input.model).disposables;
}
