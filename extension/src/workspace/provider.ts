import * as vscode from "vscode";

import { type FilesError, type Stat, toFilesError, type WorkspaceFiles } from "./files.ts";
import { namesEnvironment } from "./paths.ts";

/** The environment a window is bound to, as the provider names it in its refusals. */
export interface BoundLabel {
  readonly environmentId: string;
  readonly label: string;
}

/**
 * The `pult:` file system provider: VS Code's face of `WorkspaceFiles`. It
 * serves the bound environment's URIs and refuses another environment's,
 * since a window holds one connection.
 */
export class PultFileSystemProvider implements vscode.FileSystemProvider {
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
  private readonly files: WorkspaceFiles;
  private readonly bound: () => BoundLabel | undefined;
  /** Set when a call failed for want of a connection, so the Explorer can be refreshed once it is back. */
  failedUnavailable = false;

  constructor(
    files: WorkspaceFiles,
    changes: vscode.Event<vscode.FileChangeEvent[]>,
    bound: () => BoundLabel | undefined,
  ) {
    this.files = files;
    this.onDidChangeFile = changes;
    this.bound = bound;
  }

  /** The workspace folders' own `watchEntries` subscriptions report changes; see `WorkspaceFiles.syncWatches`. */
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.call(uri, (path) => this.files.stat(path)).then(fileStat);
  }

  readDirectory(uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> {
    return this.call(uri, (path) => this.files.readDirectory(path)).then((entries) =>
      entries.map(([name, kind]) => [
        name,
        kind === "directory" ? vscode.FileType.Directory : vscode.FileType.File,
      ]),
    );
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.call(uri, (path) => this.files.readFile(path));
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    return this.call(uri, (path) => this.files.writeFile(path, content, options));
  }

  createDirectory(uri: vscode.Uri): Promise<void> {
    return this.call(uri, (path) => this.files.createDirectory(path));
  }

  delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    return this.call(uri, (path) => this.files.delete(path, options));
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    return this.call(newUri, (to) => this.call(oldUri, (from) => this.files.rename(from, to)));
  }

  private async call<A>(uri: vscode.Uri, operation: (path: string) => Promise<A>): Promise<A> {
    const bound = this.bound();
    if (bound === undefined) {
      this.failedUnavailable = true;
      throw vscode.FileSystemError.Unavailable(
        "This window is not connected to a Pult environment.",
      );
    }
    if (!namesEnvironment(uri.authority, bound.environmentId)) {
      throw vscode.FileSystemError.Unavailable(
        `${uri.toString()} is on another environment than this window's ${bound.label}. A window holds one environment: open it in a new window.`,
      );
    }
    try {
      return await operation(uri.path);
    } catch (error) {
      if (error instanceof vscode.FileSystemError) throw error;
      const failure = toFilesError(error, uri.path);
      if (failure.code === "Unavailable") this.failedUnavailable = true;
      throw fileSystemError(failure);
    }
  }
}

function fileSystemError(failure: FilesError): vscode.FileSystemError {
  return failure.code === "Unknown"
    ? new vscode.FileSystemError(failure.message)
    : vscode.FileSystemError[failure.code](failure.message);
}

function fileStat(stat: Stat): vscode.FileStat {
  const type =
    stat.kind === "directory"
      ? vscode.FileType.Directory
      : stat.kind === "file"
        ? vscode.FileType.File
        : vscode.FileType.Unknown;
  return {
    type: stat.symlink ? type | vscode.FileType.SymbolicLink : type,
    ctime: stat.ctime,
    mtime: stat.mtime,
    size: stat.size,
    ...(stat.readonly ? { permissions: vscode.FilePermission.Readonly } : {}),
  };
}

/** Ignored entries greyed, as Git greys them, and a workspace folder gone from the host marked. */
export function workspaceDecorations(
  files: WorkspaceFiles,
  changes: vscode.Event<vscode.Uri[]>,
  scheme: string,
): vscode.Disposable {
  return vscode.window.registerFileDecorationProvider({
    onDidChangeFileDecorations: changes,
    provideFileDecoration: (uri) => {
      if (uri.scheme !== scheme) return undefined;
      if (files.isGone(uri.path)) {
        return new vscode.FileDecoration(
          "!",
          "Gone from the host",
          new vscode.ThemeColor("list.errorForeground"),
        );
      }
      if (files.isIgnored(uri.path)) {
        return new vscode.FileDecoration(
          undefined,
          "Ignored",
          new vscode.ThemeColor("pult.ignoredResourceForeground"),
        );
      }
      return undefined;
    },
  });
}
