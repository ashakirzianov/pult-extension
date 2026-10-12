import { EnvironmentId } from "@t3tools/contracts";
import * as vscode from "vscode";

import { add } from "../commands.ts";
import type { EnvironmentCatalog, WindowBinding } from "../connection/catalog.ts";
import type { WindowConnection } from "../connection/service.ts";
import { namesEnvironment, PULT_SCHEME } from "./paths.ts";

/** The window's `pult:` workspace folders. */
export function pultFolders(): ReadonlyArray<vscode.WorkspaceFolder> {
  return (vscode.workspace.workspaceFolders ?? []).filter(
    (folder) => folder.uri.scheme === PULT_SCHEME,
  );
}

/**
 * The environment the window's `pult:` folders name: the first folder's, as a
 * window binds to (`bindToFolders`) and Connect requires (`registerCommands`).
 */
export function foldersEnvironment(): EnvironmentId | undefined {
  const named = pultFolders()[0]?.uri.authority;
  return named === undefined || named === "" ? undefined : EnvironmentId.make(named);
}

/** The window's workspace folders on the environment it is bound to. */
export function boundFolders(binding: WindowBinding): ReadonlyArray<vscode.WorkspaceFolder> {
  const bound = binding.environmentId;
  return bound === undefined
    ? []
    : pultFolders().filter((folder) => namesEnvironment(folder.uri.authority, bound));
}

/**
 * Before the window's connection starts: an unbound window whose `pult:`
 * folders name an environment, as a saved `.code-workspace` does, binds to it
 * if the catalog has it. Returns the environment they name when the catalog
 * lacks it, for `offerPairing`. Several environments: the first folder's wins,
 * and `refuseForeignFolders` explains the rest.
 */
export async function bindToFolders(
  catalog: EnvironmentCatalog,
  binding: WindowBinding,
): Promise<EnvironmentId | undefined> {
  if (binding.environmentId !== undefined) return undefined;
  const named = foldersEnvironment();
  if (named === undefined) return undefined;
  const profile = catalog
    .list()
    .find((candidate) => namesEnvironment(named, candidate.environmentId));
  if (profile === undefined) return named;
  await binding.bind(profile.environmentId);
  return undefined;
}

/** The folders name an environment this VS Code has not paired with: offer to add it. */
export async function offerPairing(
  connection: WindowConnection,
  environmentId: EnvironmentId,
): Promise<void> {
  const pair = "Add Environment…";
  const choice = await vscode.window.showInformationMessage(
    "This workspace's folders are on a T3 Code environment this VS Code has not paired with.",
    pair,
  );
  if (choice === pair) await add(connection, environmentId);
}

/**
 * A bound window refuses folders of another environment, never opening a
 * second connection: the provider fails their URIs, and this says why once
 * per set of folders, offering to remove them.
 */
export function foreignFolderGuard(connection: WindowConnection, binding: WindowBinding) {
  let reported = "";
  return () => {
    const bound = binding.environmentId;
    const foreign =
      bound === undefined
        ? []
        : pultFolders().filter((folder) => !namesEnvironment(folder.uri.authority, bound));
    const key = foreign.map((folder) => folder.uri.toString()).join("\n");
    if (key === reported) return;
    reported = key;
    if (foreign.length === 0) return;
    const label = connection.environment?.label ?? bound;
    const names = foreign.map((folder) => folder.name).join(", ");
    const remove = foreign.length === 1 ? "Remove Folder" : "Remove Folders";
    void vscode.window
      .showWarningMessage(
        `${names} ${foreign.length === 1 ? "is" : "are"} on another environment than this window's ${label}. A window holds one environment: open ${foreign.length === 1 ? "it" : "them"} in a new window.`,
        remove,
      )
      .then((choice) => {
        if (choice !== remove) return;
        const folders = vscode.workspace.workspaceFolders ?? [];
        const removed = new Set(foreign.map((folder) => folder.uri.toString()));
        const kept = folders.filter((folder) => !removed.has(folder.uri.toString()));
        vscode.workspace.updateWorkspaceFolders(
          0,
          folders.length,
          ...kept.map((folder) => ({ uri: folder.uri, name: folder.name })),
        );
      });
  };
}
