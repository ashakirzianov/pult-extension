import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as vscode from "vscode";

import type { WindowBinding } from "../connection/catalog.ts";
import type { WindowConnection } from "../connection/service.ts";
import { boundFolders, foreignFolderGuard, offerPairing, pultFolders } from "./binding.ts";
import { goToFile, openProject, searchInFiles } from "./commands.ts";
import { type Change, WorkspaceFiles } from "./files.ts";
import { baseName, namesEnvironment, PULT_SCHEME, toUriPath } from "./paths.ts";
import { endedTurns, projectRoots } from "./projects.ts";
import { PultFileSystemProvider, workspaceDecorations } from "./provider.ts";
import { connectionServer } from "./server.ts";

export { bindToFolders } from "./binding.ts";

const CHANGE_TYPES: Record<Change["kind"], vscode.FileChangeType> = {
  created: vscode.FileChangeType.Created,
  changed: vscode.FileChangeType.Changed,
  deleted: vscode.FileChangeType.Deleted,
};

/**
 * The virtual workspace: the bound environment's projects and worktrees as
 * `pult:` workspace folders (`DECISIONS.md`, `pult-uri`), its commands, and
 * what keeps open files current: the folders' watches where the server has
 * them, turn ends and reconnects everywhere. `unpaired` is the environment the
 * folders name when the catalog lacks it (`bindToFolders`); `stock`, for the
 * headless load, ignores the server's feature flags (`connectionServer`).
 */
export function virtualWorkspace(
  connection: WindowConnection,
  binding: WindowBinding,
  unpaired: EnvironmentId | undefined,
  stock: () => boolean,
): Array<vscode.Disposable> {
  const server = connectionServer(connection, binding, stock);
  const changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const decorations = new vscode.EventEmitter<vscode.Uri[]>();
  const uri = (path: string) =>
    vscode.Uri.from({ scheme: PULT_SCHEME, authority: binding.environmentId ?? "", path });
  const folders = () => boundFolders(binding);
  const roots = () => folders().map((folder) => folder.uri.path);
  const files = new WorkspaceFiles(server, {
    roots,
    knownRoots: () => {
      const environment = connection.environment;
      const shell = environment === null ? undefined : Option.getOrUndefined(environment.shell);
      return shell === undefined ? [] : projectRoots(shell).map((root) => toUriPath(root.path));
    },
    openPaths: () => {
      const bound = binding.environmentId;
      if (bound === undefined) return [];
      return vscode.workspace.textDocuments
        .filter(({ uri }) => uri.scheme === PULT_SCHEME && namesEnvironment(uri.authority, bound))
        .map((document) => document.uri.path);
    },
    changed: (list) =>
      changes.fire(
        list.map((change) => ({ type: CHANGE_TYPES[change.kind], uri: uri(change.path) })),
      ),
    decorated: (paths) => decorations.fire(paths.map(uri)),
    truncated: (path, byteLength) =>
      void vscode.window.showWarningMessage(
        `Pult: ${baseName(path)} is ${(byteLength / 2 ** 20).toFixed(1)} MiB, more than the server reads, so it opened truncated and read-only.`,
      ),
  });
  const provider = new PultFileSystemProvider(files, changes.event, () => {
    const environmentId = binding.environmentId;
    if (environmentId === undefined) return undefined;
    return { environmentId, label: connection.environment?.label ?? environmentId };
  });

  const refuseForeign = foreignFolderGuard(connection, binding);
  const updateFolders = () => {
    void vscode.commands.executeCommand("setContext", "pult.workspace", pultFolders().length > 0);
    refuseForeign();
    void files.syncWatches();
  };

  let environmentId: EnvironmentId | undefined;
  let ready = false;
  let completions = new Map<string, number>();
  const followConnection = () => {
    const environment = connection.environment;
    if (environment?.environmentId !== environmentId) {
      environmentId = environment?.environmentId;
      completions = new Map();
      refuseForeign();
    }
    // Changes made while the window was offline went unseen.
    if (environment?.phase === "ready" && !ready) {
      void files.syncWatches();
      for (const root of roots()) void files.refresh(root);
      if (provider.failedUnavailable) {
        provider.failedUnavailable = false;
        void vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
      }
    }
    ready = environment?.phase === "ready";
    const shell = environment === null ? undefined : Option.getOrUndefined(environment.shell);
    if (shell === undefined) return;
    const ended = endedTurns(completions, shell);
    completions = ended.seen;
    for (const root of ended.roots) void files.refresh(toUriPath(root));
  };

  updateFolders();
  followConnection();
  if (unpaired !== undefined) void offerPairing(connection, unpaired);
  return [
    vscode.workspace.registerFileSystemProvider(PULT_SCHEME, provider, { isCaseSensitive: true }),
    workspaceDecorations(files, decorations.event, PULT_SCHEME),
    files,
    changes,
    decorations,
    vscode.workspace.onDidChangeWorkspaceFolders(updateFolders),
    connection.onDidChange(followConnection),
    vscode.commands.registerCommand("pult.openProject", () => openProject(connection, folders)),
    vscode.commands.registerCommand("pult.goToFile", () => goToFile(server, folders)),
    vscode.commands.registerCommand("pult.searchInFiles", () => searchInFiles(server, folders)),
  ];
}
