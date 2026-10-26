import type {
  ProjectCreateDirectoryInput,
  ProjectCreateDirectoryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameEntryInput,
  ProjectRenameEntryResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectStatEntryInput,
  ProjectStatEntryResult,
  ProjectWatchEntriesEvent,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
  ServerConfig,
} from "@t3tools/contracts";

import {
  baseName,
  joinPath,
  type Located,
  locate,
  parentOf,
  relativeTo,
  toHostPath,
} from "./paths.ts";

/**
 * The server features the workspace uses only where the server config
 * advertises them; each has a stock behaviour (`pult/decisions`,
 * `capability-gated-rpcs`).
 */
export interface Features {
  /** `statEntry`, and versions on reads and writes: a write over a changed file fails. */
  readonly fileVersions: boolean;
  /** `createDirectory`, `deleteEntry`, `renameEntry`. */
  readonly entryMutations: boolean;
  readonly watchEntries: boolean;
  /** Any file's bytes over the asset route, binary ones included. */
  readonly fileAssets: boolean;
}

export function featuresOf(
  config: Pick<
    ServerConfig,
    "projectFileVersions" | "projectEntryMutations" | "projectWatchEntries" | "workspaceFileAssets"
  >,
): Features {
  return {
    fileVersions: config.projectFileVersions === true,
    entryMutations: config.projectEntryMutations === true,
    watchEntries: config.projectWatchEntries === true,
    fileAssets: config.workspaceFileAssets === true,
  };
}

export interface Disposable {
  dispose(): void;
}

/** What a root's `watchEntries` subscription reports. */
export interface WatchListener {
  /**
   * A subscription started, the first or after the server's watcher closed or
   * the connection came back; settles once the open files are re-read.
   */
  readonly subscribed: () => Promise<void>;
  readonly changed: (event: ProjectWatchEntriesEvent) => void;
  /** The root is gone from the host; the subscription has ended for good. */
  readonly gone: () => void;
}

/**
 * What the workspace asks of the bound environment: the vendored project RPCs,
 * the asset route and the server's features. A call rejects with the RPC's
 * error, or with `EnvironmentRpcUnavailableError` while the window has no live
 * connection.
 */
export interface WorkspaceServer {
  readonly features: () => Promise<Features>;
  readonly listEntries: (input: ProjectListEntriesInput) => Promise<ProjectListEntriesResult>;
  readonly readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
  readonly statEntry: (input: ProjectStatEntryInput) => Promise<ProjectStatEntryResult>;
  readonly writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  readonly createDirectory: (
    input: ProjectCreateDirectoryInput,
  ) => Promise<ProjectCreateDirectoryResult>;
  readonly deleteEntry: (input: ProjectDeleteEntryInput) => Promise<ProjectDeleteEntryResult>;
  readonly renameEntry: (input: ProjectRenameEntryInput) => Promise<ProjectRenameEntryResult>;
  readonly searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
  readonly searchContents: (
    input: ProjectSearchContentsInput,
  ) => Promise<ProjectSearchContentsResult>;
  /** A file's whole bytes over the asset route, by a URL minted for this read alone. */
  readonly readAsset: (cwd: string, relativePath: string) => Promise<Uint8Array>;
  readonly watchEntries: (cwd: string, listener: WatchListener) => Disposable;
}

export type FilesErrorCode =
  | "FileNotFound"
  | "FileExists"
  | "FileNotADirectory"
  | "FileIsADirectory"
  | "NoPermissions"
  | "Unavailable"
  | "Unknown";

/** A failure the provider hands VS Code as the `FileSystemError` of the same name. */
export class FilesError extends Error {
  readonly code: FilesErrorCode;

  constructor(code: FilesErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Why a file opened read-only: only part of it was read, or its bytes did not survive the server's UTF-8 decoding. */
export type ReadOnlyReason = "truncated" | "lossy";

export interface Stat {
  readonly kind: ProjectStatEntryResult["kind"];
  readonly symlink: boolean;
  readonly ctime: number;
  readonly mtime: number;
  readonly size: number;
  readonly readonly: boolean;
}

export interface Change {
  readonly path: string;
  readonly kind: "created" | "changed" | "deleted";
}

/** The window the files serve. Every path is a `pult:` URI path on the bound environment. */
export interface WorkspaceFilesHost {
  /** The window's workspace folders: the roots browsed, watched and written under. */
  readonly roots: () => ReadonlyArray<string>;
  /** The environment's project and worktree roots, against which a file outside the folders is read and written. */
  readonly knownRoots: () => ReadonlyArray<string>;
  /** The documents open in the window. */
  readonly openPaths: () => ReadonlyArray<string>;
  readonly changed: (changes: ReadonlyArray<Change>) => void;
  /** Paths whose ignored or gone mark changed. */
  readonly decorated: (paths: ReadonlyArray<string>) => void;
  /** A read cannot be written back, once per path and reason: the file opens read-only. */
  readonly openedReadOnly: (path: string, reason: ReadOnlyReason, byteLength: number) => void;
}

const MUTATIONS_UNSUPPORTED =
  "This server cannot create, move or delete files for Pult. A server that advertises projectEntryMutations can.";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8 = new TextEncoder();

/**
 * The workspace folders' files over the server's project RPCs: the logic of
 * the `pult:` file system provider, without VS Code's types.
 *
 * VS Code refuses to save over a file whose stat is newer and of another size
 * than the stat its editor recorded, and stats it again before it writes. On a
 * server with versions, an open file changed since its contents were served is
 * reported so that this check always refuses (`report`), and a write expects
 * the version served. On a stock server, which has no `statEntry`, a stat is
 * synthesized: the kind from the parent's listing, or from a read where the
 * listing leaves the path out, as it does a symlink, and the mtime and size
 * counters, bumped on the provider's own writes and when a file's contents
 * are found changed at turn end.
 */
export class WorkspaceFiles implements Disposable {
  private readonly server: WorkspaceServer;
  private readonly host: WorkspaceFilesHost;
  private readonly now: () => number;
  private readonly epoch: number;
  private clock: number;
  /**
   * The version of the contents last served or written, which an open editor
   * is taken to hold, and writeFile's `expectedVersion`.
   */
  private readonly served = new Map<string, string>();
  /** The highest mtime and size each file was reported at. */
  private readonly reported = new Map<string, { readonly mtime: number; readonly size: number }>();
  /**
   * What a write may overwrite, by the latest stat of the file: the version of
   * a file it reported changed, since VS Code's check refuses to save over that
   * and a write that follows skipped the check, as Overwrite does; or nothing,
   * for a file it found missing, which the write creates.
   */
  private readonly overwritable = new Map<string, string | undefined>();
  /** Each file's contents as last read or written, digested, to tell a changed file on a stock server. */
  private readonly digests = new Map<string, string>();
  private readonly mtimes = new Map<string, number>();
  private readonly readOnly = new Map<string, ReadOnlyReason>();
  private readonly ignored = new Set<string>();
  private readonly goneRoots = new Set<string>();
  private readonly watches = new Map<string, Disposable>();
  private readonly listings = new Map<string, Promise<ReadonlyArray<ProjectEntry>>>();

  constructor(server: WorkspaceServer, host: WorkspaceFilesHost, now: () => number = Date.now) {
    this.server = server;
    this.host = host;
    this.now = now;
    this.epoch = now();
    this.clock = this.epoch;
  }

  async stat(path: string): Promise<Stat> {
    const target = this.target(path);
    const features = await this.server.features();
    const readonly = this.editable(path) === undefined || this.readOnly.has(path);
    // A file that turned read-only reads 1 ms newer, so its open editor re-reads it and takes that.
    const nudge = this.readOnly.has(path) ? 1 : 0;
    if (features.fileVersions) {
      let entry: ProjectStatEntryResult;
      try {
        entry = await this.server.statEntry({ cwd: target.cwd, relativePath: target.relativePath });
      } catch (error) {
        const failure = toFilesError(error, path);
        if (failure.code === "FileNotFound") this.overwritable.set(path, undefined);
        else this.overwritable.delete(path);
        throw failure;
      }
      const { mtime, size } =
        entry.kind === "file"
          ? this.report(path, entry, readonly, nudge)
          : { mtime: entry.mtimeMs, size: entry.size };
      return {
        kind: entry.kind,
        symlink: entry.symlink,
        ctime: entry.birthtimeMs,
        mtime,
        size,
        readonly,
      };
    }
    const mtime = this.mtimes.get(path) ?? this.epoch;
    return {
      kind: await this.listedKind(path, target.folder),
      symlink: false,
      ctime: this.epoch,
      mtime: mtime + nudge,
      size: mtime - this.epoch,
      readonly,
    };
  }

  /** Only the workspace folders are browsed. */
  async readDirectory(path: string): Promise<Array<[string, ProjectEntry["kind"]]>> {
    const folder = locate(this.host.roots(), path);
    if (folder === undefined) {
      throw new FilesError("NoPermissions", `Pult browses only the workspace folders: ${path}.`);
    }
    const entries = await this.list(folder.root, folder.relativePath);
    return entries.map((entry) => [baseName(entry.path), entry.kind]);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const target = this.target(path);
    if (target.relativePath === "") throw new FilesError("FileIsADirectory", path);
    let result: ProjectReadFileResult;
    try {
      result = await this.server.readFile({ cwd: target.cwd, relativePath: target.relativePath });
    } catch (error) {
      const failure = field(error, "failure");
      if (failure === "binary_file") return this.readBinary(path, target);
      // A stock server fails the read of a missing file as an operation; a stat tells that from the rest.
      if (failure === "operation_failed" && !(await this.exists(path))) throw new FilesError("FileNotFound", path);
      throw toFilesError(error, path);
    }
    const bytes = utf8.encode(result.contents);
    const reason = readOnlyReason(result, bytes.length);
    if (reason !== this.readOnly.get(path)) {
      if (reason === undefined) this.readOnly.delete(path);
      else {
        this.readOnly.set(path, reason);
        this.host.openedReadOnly(path, reason, result.byteLength);
      }
      // After this read is answered: the open editor re-stats and takes the new read-only state.
      setTimeout(() => this.host.changed([{ path, kind: "changed" }]), 0);
    }
    // A truncated read has no version, so it can never be written back as the whole file.
    if (result.version === undefined) this.served.delete(path);
    else this.served.set(path, result.version);
    this.overwritable.delete(path);
    this.digests.set(path, digest(result.contents));
    return bytes;
  }

  async writeFile(
    path: string,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    const folder = this.writable(path);
    let contents: string;
    try {
      contents = strictUtf8.decode(content);
    } catch {
      throw new FilesError(
        "NoPermissions",
        `${baseName(path)} is not UTF-8 text. The server takes a file's contents as text, so Pult refuses to write it rather than corrupt it.`,
      );
    }
    const features = await this.server.features();
    const reason = this.readOnly.get(path);
    // Taken before the existence check, whose stat would replace it.
    const expected = this.overwritable.has(path)
      ? this.overwritable.get(path)
      : this.served.get(path);
    const exists =
      !features.entryMutations || !options.create || !options.overwrite || reason !== undefined
        ? await this.exists(path)
        : undefined;
    // The mark outlives a delete on the host; a new file at the path is not the one it marks.
    if (reason !== undefined && exists === true) {
      throw new FilesError("NoPermissions", readOnlyMessage(path, reason));
    }
    if (exists === false && !options.create) throw new FilesError("FileNotFound", path);
    if (exists === true && !options.overwrite) throw new FilesError("FileExists", path);
    if (exists === false && !features.entryMutations) {
      throw new FilesError("NoPermissions", MUTATIONS_UNSUPPORTED);
    }
    // A new file has no version to expect.
    const expectedVersion = features.fileVersions && exists !== false ? expected : undefined;
    const result = await this.server
      .writeFile({
        cwd: toHostPath(folder.root),
        relativePath: folder.relativePath,
        contents,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      })
      .catch(failed(path));
    if (features.fileVersions && result.version !== undefined) {
      this.served.set(path, result.version);
    }
    this.overwritable.delete(path);
    this.digests.set(path, digest(contents));
    this.bump(path);
    this.host.changed([{ path, kind: exists === false ? "created" : "changed" }]);
  }

  async createDirectory(path: string): Promise<void> {
    const folder = this.writable(path);
    await this.requireMutations();
    await this.server
      .createDirectory({ cwd: toHostPath(folder.root), relativePath: folder.relativePath })
      .catch(failed(path));
    this.host.changed([{ path, kind: "created" }]);
  }

  async delete(path: string, options: { readonly recursive: boolean }): Promise<void> {
    const folder = this.writable(path);
    await this.requireMutations();
    await this.server
      .deleteEntry({
        cwd: toHostPath(folder.root),
        relativePath: folder.relativePath,
        recursive: options.recursive,
      })
      .catch(failed(path));
    this.forget(path);
    this.host.changed([{ path, kind: "deleted" }]);
  }

  /** The server never replaces an entry; VS Code deletes the target itself before an overwriting move. */
  async rename(from: string, to: string): Promise<void> {
    const source = this.writable(from);
    const target = this.writable(to);
    if (source.root !== target.root) {
      throw new FilesError("NoPermissions", "Pult moves entries only within one workspace folder.");
    }
    await this.requireMutations();
    await this.server
      .renameEntry({
        cwd: toHostPath(source.root),
        relativePath: source.relativePath,
        newRelativePath: target.relativePath,
      })
      .catch(failed(from));
    this.forget(from);
    this.host.changed([
      { path: from, kind: "deleted" },
      { path: to, kind: "created" },
    ]);
  }

  /**
   * Copies a file, or a folder of the workspace folders with everything it
   * lists. VS Code would copy a file by reading it as text and writing that
   * back, corrupting one the server cannot read back exactly: such a file is
   * copied from its bytes over the asset route, if they are UTF-8 text, the
   * only contents the server writes, and refused otherwise.
   */
  async copy(from: string, to: string, options: { readonly overwrite: boolean }): Promise<void> {
    this.writable(to);
    if (relativeTo(from, to) !== undefined) {
      throw new FilesError("NoPermissions", `Pult cannot copy ${baseName(from)} into itself.`);
    }
    const features = await this.server.features();
    if (!features.entryMutations) throw new FilesError("NoPermissions", MUTATIONS_UNSUPPORTED);
    if (!options.overwrite && (await this.exists(to))) throw new FilesError("FileExists", to);
    const source = this.target(from);
    const kind = features.fileVersions
      ? (
          await this.server
            .statEntry({ cwd: source.cwd, relativePath: source.relativePath })
            .catch(failed(from))
        ).kind
      : await this.listedKind(from, source.folder);
    if (kind === "other") {
      throw new FilesError("NoPermissions", `Pult copies only files and folders: ${from}.`);
    }
    await this.copyEntry(from, to, kind);
    this.host.changed([{ path: to, kind: "created" }]);
  }

  /**
   * The open files under `under` may have changed on the host: a turn ended
   * there, the connection came back, or a watch (re)started. On a server with
   * versions each is re-stat'd by VS Code; on a stock server each is re-read
   * and reported only if its contents changed, so an unchanged dirty file
   * never meets a spurious modified-since conflict.
   */
  async refresh(under: string): Promise<void> {
    const open = this.host.openPaths().filter((path) => relativeTo(under, path) !== undefined);
    if (open.length === 0) return;
    const features = await this.server.features().catch(() => undefined);
    if (features === undefined) return;
    if (features.fileVersions) {
      this.host.changed(open.map((path) => ({ path, kind: "changed" })));
      return;
    }
    const changes = (await Promise.all(open.map((path) => this.recheck(path)))).filter(
      (change) => change !== undefined,
    );
    for (const change of changes) {
      if (change.kind === "deleted") this.forget(change.path, "host");
      else this.bump(change.path);
    }
    if (changes.length > 0) this.host.changed(changes);
  }

  /**
   * One `watchEntries` subscription per workspace folder, where the server
   * advertises it. Called when the folders change and when the connection
   * becomes ready; a folder found gone is not watched again.
   */
  async syncWatches(): Promise<void> {
    const features = await this.server.features().catch(() => undefined);
    if (features === undefined) return;
    const roots = new Set(features.watchEntries ? this.host.roots() : []);
    for (const [root, watch] of this.watches) {
      if (roots.has(root)) continue;
      watch.dispose();
      this.watches.delete(root);
    }
    for (const root of roots) {
      if (this.watches.has(root) || this.goneRoots.has(root)) continue;
      this.watches.set(root, this.server.watchEntries(toHostPath(root), this.watchListener(root)));
    }
  }

  isIgnored(path: string): boolean {
    return this.ignored.has(path);
  }

  /** A workspace folder whose directory is gone from the host. */
  isGone(path: string): boolean {
    return this.goneRoots.has(path);
  }

  dispose(): void {
    for (const watch of this.watches.values()) watch.dispose();
    this.watches.clear();
  }

  private watchListener(root: string): WatchListener {
    return {
      subscribed: () => this.refresh(root),
      changed: ({ changes, truncated }) => {
        const reported = changes.map((change) => ({
          path: joinPath(root, change.path),
          kind: change.kind,
        }));
        for (const change of reported) {
          if (change.kind === "deleted") this.forget(change.path, "host");
        }
        if (reported.length > 0) this.host.changed(reported);
        // More changed than the batch names.
        if (truncated) void this.refresh(root);
      },
      gone: () => {
        this.watches.get(root)?.dispose();
        this.watches.delete(root);
        this.goneRoots.add(root);
        this.forget(root);
        this.host.changed([{ path: root, kind: "deleted" }]);
        this.host.decorated([root]);
      },
    };
  }

  /**
   * The cwd and path an RPC names for `path`: relative to the innermost
   * workspace folder holding it, else to a project or worktree root, else
   * absolute against any root, as a thread's citation may be.
   */
  private target(path: string): Target {
    const folder = locate(this.host.roots(), path);
    if (folder !== undefined) {
      return { cwd: toHostPath(folder.root), relativePath: folder.relativePath, folder };
    }
    const known = locate(this.host.knownRoots(), path);
    if (known !== undefined) {
      return { cwd: toHostPath(known.root), relativePath: known.relativePath, folder: undefined };
    }
    const anyRoot = this.host.roots()[0] ?? this.host.knownRoots()[0];
    if (anyRoot === undefined) {
      throw new FilesError("Unavailable", "The environment has listed no projects yet.");
    }
    return { cwd: toHostPath(anyRoot), relativePath: toHostPath(path), folder: undefined };
  }

  /**
   * Where a path is written, if anywhere: under a workspace folder, or under one
   * of the environment's known roots, so a file of another project, or of a root
   * the folders no longer hold, still saves. Browsing and search stay the folders'.
   */
  private editable(path: string): Located | undefined {
    return locate(this.host.roots(), path) ?? locate(this.host.knownRoots(), path);
  }

  /** Writes go only under an editable root, never to a root itself. */
  private writable(path: string): Located {
    const folder = this.editable(path);
    if (folder === undefined || folder.relativePath === "") {
      throw new FilesError(
        "NoPermissions",
        `Pult writes only under the environment's project folders: ${path}.`,
      );
    }
    // The server trims a path's ends: "foo " would be written as "foo".
    const untrimmed = folder.relativePath.split("/").find((name) => name !== name.trim());
    if (untrimmed !== undefined) {
      throw new FilesError(
        "NoPermissions",
        `Pult cannot write "${untrimmed}": the server trims whitespace from the ends of a path, so the write would land on another entry.`,
      );
    }
    return folder;
  }

  private async requireMutations(): Promise<void> {
    if (!(await this.server.features()).entryMutations) {
      throw new FilesError("NoPermissions", MUTATIONS_UNSUPPORTED);
    }
  }

  /**
   * The mtime and size VS Code is told for a file on a server with versions.
   * An editor's recorded stat is an earlier report, or one from before a
   * reload, so a writable open file not at the version served, or never
   * served, as an editor restored from a backup is not, is reported above
   * them all: later than every mtime reported for it and than the clock, and
   * at a size above every one reported, plus half a byte, which no real file
   * has. VS Code then refuses to save over it, whatever the change did to the
   * file's real mtime and size.
   */
  private report(
    path: string,
    entry: ProjectStatEntryResult,
    readonly: boolean,
    nudge: number,
  ): { mtime: number; size: number } {
    const last = this.reported.get(path);
    const changed =
      !readonly && this.served.get(path) !== entry.version && this.host.openPaths().includes(path);
    const reported = changed
      ? {
          mtime: Math.max(entry.mtimeMs, this.now(), (last?.mtime ?? -Infinity) + 1),
          size: Math.max(entry.size, Math.ceil(last?.size ?? 0)) + 0.5,
        }
      : { mtime: entry.mtimeMs + nudge, size: entry.size };
    this.reported.set(path, {
      mtime: Math.max(reported.mtime, last?.mtime ?? -Infinity),
      size: Math.max(reported.size, last?.size ?? 0),
    });
    if (changed) this.overwritable.set(path, entry.version);
    else this.overwritable.delete(path);
    return reported;
  }

  /** A stock server's stat: a file outside the folders is taken for a file until a read says otherwise. */
  private async listedKind(
    path: string,
    folder: Located | undefined,
  ): Promise<ProjectEntry["kind"]> {
    if (folder === undefined) return "file";
    if (folder.relativePath === "") return "directory";
    const entries = await this.list(folder.root, parentOf(folder.relativePath));
    const entry = entries.find((candidate) => candidate.path === folder.relativePath);
    if (entry !== undefined) return entry.kind;
    // The listing leaves out symlinks: a read says whether the path is there, and what it is.
    try {
      await this.server.readFile({
        cwd: toHostPath(folder.root),
        relativePath: folder.relativePath,
      });
      return "file";
    } catch (error) {
      switch (field(error, "failure")) {
        case "binary_file":
          return "file";
        case "path_not_file":
          return "directory";
        // A stock server fails the read of a missing file as an operation.
        case "path_not_found":
        case "operation_failed":
          throw new FilesError("FileNotFound", path);
      }
      throw toFilesError(error, path);
    }
  }

  /** A directory's children, sharing one request among concurrent callers, and their ignored marks. */
  private list(root: string, directoryPath: string): Promise<ReadonlyArray<ProjectEntry>> {
    const key = joinPath(root, directoryPath);
    const pending = this.listings.get(key);
    if (pending !== undefined) return pending;
    const listing = this.server
      .listEntries({ cwd: toHostPath(root), directoryPath })
      .then(({ entries }) => {
        this.markIgnored(root, entries);
        return entries;
      }, failed(key))
      .finally(() => this.listings.delete(key));
    this.listings.set(key, listing);
    return listing;
  }

  private markIgnored(root: string, entries: ReadonlyArray<ProjectEntry>): void {
    const decorated: Array<string> = [];
    for (const entry of entries) {
      const path = joinPath(root, entry.path);
      const ignored = entry.ignored === true;
      if (ignored === this.ignored.has(path)) continue;
      if (ignored) this.ignored.add(path);
      else this.ignored.delete(path);
      decorated.push(path);
    }
    if (decorated.length > 0) this.host.decorated(decorated);
  }

  private readBinary(path: string, target: Target): Promise<Uint8Array> {
    return this.readAsset(
      path,
      target,
      `${baseName(path)} is a binary file, which this server cannot send to Pult. A server that advertises workspaceFileAssets can.`,
    );
  }

  /** A file's bytes over the asset route, which serves any file by a path relative to its root. */
  private async readAsset(path: string, target: Target, unavailable: string): Promise<Uint8Array> {
    const features = await this.server.features();
    if (!features.fileAssets || toHostPath(path) === target.relativePath) {
      throw new FilesError("Unavailable", unavailable);
    }
    return this.server.readAsset(target.cwd, target.relativePath).catch(failed(path));
  }

  private async copyEntry(from: string, to: string, kind: ProjectEntry["kind"]): Promise<void> {
    const target = this.writable(to);
    const source = this.target(from);
    if (kind === "file") {
      const contents = await this.exactText(from, source);
      await this.server
        .writeFile({ cwd: toHostPath(target.root), relativePath: target.relativePath, contents })
        .catch(failed(to));
      this.bump(to);
      return;
    }
    if (source.folder === undefined) {
      throw new FilesError("NoPermissions", `Pult browses only the workspace folders: ${from}.`);
    }
    const listing = await this.server
      .listEntries({ cwd: source.cwd, directoryPath: source.relativePath })
      .catch(failed(from));
    if (listing.truncated) {
      throw new FilesError(
        "NoPermissions",
        `${baseName(from)} holds more entries than the server lists at once, so Pult cannot copy all of it.`,
      );
    }
    await this.server
      .createDirectory({ cwd: toHostPath(target.root), relativePath: target.relativePath })
      .catch(failed(to));
    for (const entry of listing.entries) {
      const name = baseName(entry.path);
      await this.copyEntry(joinPath(from, name), joinPath(to, name), entry.kind);
    }
  }

  /** A file's whole contents as text the server writes back byte for byte. */
  private async exactText(path: string, source: Target): Promise<string> {
    const name = baseName(path);
    let unreadable = `${name} is a binary file`;
    try {
      const result = await this.server.readFile({
        cwd: source.cwd,
        relativePath: source.relativePath,
      });
      const reason = readOnlyReason(result, utf8.encode(result.contents).length);
      if (reason === undefined) return result.contents;
      unreadable =
        reason === "truncated"
          ? `${name} is larger than the server reads`
          : `${name} is not plain UTF-8`;
    } catch (error) {
      if (field(error, "failure") !== "binary_file") throw toFilesError(error, path);
    }
    const unavailable = `${unreadable}, and this server cannot send Pult its bytes, so Pult will not copy it. A server that advertises workspaceFileAssets can.`;
    const bytes = await this.readAsset(path, source, unavailable);
    try {
      return strictUtf8.decode(bytes);
    } catch {
      throw new FilesError(
        "NoPermissions",
        `${name} is not UTF-8 text, and the server writes only text, so Pult will not copy it rather than corrupt it.`,
      );
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if (error instanceof FilesError && error.code === "FileNotFound") return false;
      throw error;
    }
  }

  /** An open file re-read on a stock server: changed or deleted, or undefined if its contents are as last seen. */
  private async recheck(path: string): Promise<Change | undefined> {
    const seen = this.digests.get(path);
    if (seen === undefined) return undefined;
    try {
      const target = this.target(path);
      const result = await this.server.readFile({
        cwd: target.cwd,
        relativePath: target.relativePath,
      });
      return digest(result.contents) === seen ? undefined : { path, kind: "changed" };
    } catch (error) {
      return field(error, "failure") === "path_not_found" ? { path, kind: "deleted" } : undefined;
    }
  }

  private bump(path: string): void {
    this.clock += 1;
    this.mtimes.set(path, this.clock);
  }

  /**
   * Drops what is known of `path` and everything under it. Their synthesized
   * mtimes move on rather than back, so a file deleted and made again never
   * stats as it did before. A delete seen on the `host` keeps the contents
   * served and the read-only marks until a read replaces them: a file deleted
   * and made again, as `git checkout` does, is still not what an open editor
   * holds.
   */
  private forget(path: string, by: "provider" | "host" = "provider"): void {
    const known =
      by === "host"
        ? [this.overwritable]
        : [this.served, this.overwritable, this.digests, this.readOnly];
    for (const map of known) {
      for (const key of map.keys()) if (relativeTo(path, key) !== undefined) map.delete(key);
    }
    for (const key of this.mtimes.keys()) {
      if (key !== path && relativeTo(path, key) !== undefined) this.bump(key);
    }
    this.bump(path);
  }
}

/** Where an RPC finds a path; `folder` is the workspace folder holding it, if one does. */
interface Target {
  readonly cwd: string;
  readonly relativePath: string;
  readonly folder: Located | undefined;
}

/** Why a read cannot be written back. The server decodes leniently: an invalid byte reads as U+FFFD and a BOM is dropped. */
function readOnlyReason(
  result: ProjectReadFileResult,
  encodedLength: number,
): ReadOnlyReason | undefined {
  if (result.truncated) return "truncated";
  return encodedLength !== result.byteLength || result.contents.includes("\uFFFD")
    ? "lossy"
    : undefined;
}

function readOnlyMessage(path: string, reason: ReadOnlyReason): string {
  return reason === "truncated"
    ? `${baseName(path)} is larger than the server reads, so Pult opened only its start and will not write it back.`
    : `${baseName(path)} is not plain UTF-8 (a byte-order mark, or another encoding), and the server reads it as text, so Pult will not write it back.`;
}

/** A rejection handler that rethrows the server's error as the `FilesError` for `path`. */
function failed(path: string) {
  return (error: unknown): never => {
    throw toFilesError(error, path);
  };
}

export function toFilesError(error: unknown, path: string): FilesError {
  if (error instanceof FilesError) return error;
  const message = field(error, "message") ?? String(error);
  switch (field(error, "_tag")) {
    case "EnvironmentRpcUnavailableError":
    case "RpcClientError":
      return new FilesError("Unavailable", message);
    case "EnvironmentAuthorizationError":
      return new FilesError("NoPermissions", message);
  }
  switch (field(error, "failure")) {
    case "path_not_found":
    case "workspace_root_not_found":
    case "directory_list_failed":
      return new FilesError("FileNotFound", message);
    case "path_exists":
      return new FilesError("FileExists", message);
    case "path_not_file":
      return new FilesError("FileIsADirectory", message);
    case "workspace_path_outside_root":
    case "resolved_path_outside_root":
      return new FilesError("NoPermissions", message);
    case "version_conflict":
      return new FilesError(
        "Unknown",
        `${baseName(path)} changed on the host since Pult read it, so saving would overwrite that change.`,
      );
  }
  return new FilesError("Unknown", message);
}

function field(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const found: unknown = Reflect.get(value, key);
  return typeof found === "string" ? found : undefined;
}

/** FNV-1a over the UTF-16 code units, with the length: enough to tell contents changed. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${hash >>> 0}`;
}
