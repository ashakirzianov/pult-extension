import * as Option from "effect/Option";
import * as vscode from "vscode";

import type { WindowConnection } from "../connection/service.ts";
import type { WorkspaceServer } from "./files.ts";
import { baseName, joinPath, parentOf, PULT_SCHEME, toHostPath, toUriPath } from "./paths.ts";
import { type ProjectRoot, projectRoots } from "./projects.ts";

const SEARCH_DELAY_MS = 150;
const ENTRY_LIMIT = 50;
const CONTENT_LIMIT = 200;

/**
 * "Pult: Open Project": a project of the bound environment, or a worktree its
 * threads run in, added as a workspace folder. VS Code restarts the extension
 * host when a window gains its first folder; the window then binds to the
 * environment its `pult:` folders name.
 */
export async function openProject(
  connection: WindowConnection,
  folders: () => ReadonlyArray<vscode.WorkspaceFolder>,
) {
  const environment = connection.environment;
  if (environment === null) return vscode.commands.executeCommand("pult.connect");
  const shell = Option.getOrUndefined(environment.shell);
  if (shell === undefined) {
    return vscode.window.showInformationMessage(
      `Pult: ${environment.label} has not listed its projects yet.`,
    );
  }
  const roots = projectRoots(shell);
  if (roots.length === 0) {
    return vscode.window.showInformationMessage(`Pult: ${environment.label} has no projects.`);
  }
  const items: Array<vscode.QuickPickItem & { root?: ProjectRoot }> = [];
  for (const root of roots) {
    if (root.worktree === null) {
      items.push({ label: root.project, kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({
      label: root.worktree === null ? `$(repo) ${root.project}` : `$(git-branch) ${root.worktree}`,
      description: root.path,
      root,
    });
  }
  const picked = (
    await vscode.window.showQuickPick(items, {
      placeHolder: `Open a project or worktree of ${environment.label} as a workspace folder`,
      matchOnDescription: true,
    })
  )?.root;
  if (picked === undefined) return;
  const uri = vscode.Uri.from({
    scheme: PULT_SCHEME,
    authority: environment.environmentId,
    path: toUriPath(picked.path),
  });
  if (folders().some((folder) => folder.uri.path === uri.path)) {
    return vscode.commands.executeCommand("revealInExplorer", uri);
  }
  const count = vscode.workspace.workspaceFolders?.length ?? 0;
  if (!vscode.workspace.updateWorkspaceFolders(count, 0, { uri, name: picked.name })) {
    void vscode.window.showErrorMessage(`Pult could not add ${picked.name} to the workspace.`);
  }
}

type FileItem = vscode.QuickPickItem & { readonly uri: vscode.Uri };
type MatchItem = FileItem & { readonly selection: vscode.Range };

/** "Pult: Go to File": quick open over the server's `searchEntries` in every workspace folder. */
export function goToFile(
  server: WorkspaceServer,
  folders: () => ReadonlyArray<vscode.WorkspaceFolder>,
) {
  searchPick<FileItem>(
    folders(),
    { placeholder: "Search files by name", searchEmpty: true },
    async (query, folder) => {
      const { entries } = await server.searchEntries({
        cwd: toHostPath(folder.uri.path),
        query: query.trim().slice(0, 256),
        limit: ENTRY_LIMIT,
        kind: "file",
      });
      return entries.map((entry) => ({
        label: baseName(entry.path),
        description: [folder.name, parentOf(entry.path)].filter((part) => part !== "").join(" · "),
        uri: folder.uri.with({ path: joinPath(folder.uri.path, entry.path) }),
        alwaysShow: true,
      }));
    },
    (item) => vscode.commands.executeCommand("vscode.open", item.uri),
  );
}

/**
 * "Pult: Search in Files": the server's `searchContents` in every workspace
 * folder, as a quick pick; VS Code's search view needs a proposed API.
 */
export function searchInFiles(
  server: WorkspaceServer,
  folders: () => ReadonlyArray<vscode.WorkspaceFolder>,
) {
  searchPick<MatchItem>(
    folders(),
    { placeholder: "Search file contents", searchEmpty: false },
    async (query, folder) => {
      const { matches } = await server.searchContents({
        cwd: toHostPath(folder.uri.path),
        query: query.slice(0, 256),
        limit: CONTENT_LIMIT,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });
      return matches.map((match) => {
        const range = match.matchRanges[0];
        const line = match.lineNumber - 1;
        return {
          label: match.lineContent.trim(),
          description: `${match.path}:${match.lineNumber}`,
          detail: folder.name,
          uri: folder.uri.with({ path: joinPath(folder.uri.path, match.path) }),
          selection: new vscode.Range(line, range?.start ?? 0, line, range?.end ?? 0),
          alwaysShow: true,
        };
      });
    },
    (item) => vscode.window.showTextDocument(item.uri, { selection: item.selection }),
  );
}

/** A quick pick that searches the workspace folders as the user types, dropping stale answers. */
function searchPick<Item extends FileItem>(
  folders: ReadonlyArray<vscode.WorkspaceFolder>,
  options: { readonly placeholder: string; readonly searchEmpty: boolean },
  search: (query: string, folder: vscode.WorkspaceFolder) => Promise<Array<Item>>,
  open: (item: Item) => Thenable<unknown>,
) {
  if (folders.length === 0) {
    void vscode.window.showInformationMessage("Pult: open a project first (Pult: Open Project).");
    return;
  }
  const pick = vscode.window.createQuickPick<Item>();
  pick.placeholder = options.placeholder;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (query: string) => {
    const current = ++generation;
    if (query === "" && !options.searchEmpty) {
      pick.items = [];
      pick.busy = false;
      return;
    }
    pick.busy = true;
    const failures: Array<string> = [];
    const results = await Promise.all(
      folders.map((folder) =>
        search(query, folder).catch((error: unknown) => {
          failures.push(error instanceof Error ? error.message : String(error));
          return [];
        }),
      ),
    );
    if (current !== generation) return;
    pick.items = results.flat();
    pick.placeholder = failures[0] ?? options.placeholder;
    pick.busy = false;
  };
  pick.onDidChangeValue((query) => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(query), SEARCH_DELAY_MS);
  });
  pick.onDidAccept(() => {
    const [item] = pick.selectedItems;
    if (item === undefined) return;
    pick.hide();
    void open(item);
  });
  pick.onDidHide(() => {
    clearTimeout(timer);
    pick.dispose();
  });
  pick.show();
  void run("");
}
