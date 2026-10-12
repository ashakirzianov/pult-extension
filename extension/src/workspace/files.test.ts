import type {
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectWatchEntriesEvent,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type Change,
  type Features,
  FilesError,
  type Stat,
  type WatchListener,
  WorkspaceFiles,
  type WorkspaceServer,
} from "./files.ts";

const STOCK: Features = {
  fileVersions: false,
  entryMutations: false,
  watchEntries: false,
  fileAssets: false,
};
const CAPABLE: Features = {
  fileVersions: true,
  entryMutations: true,
  watchEntries: true,
  fileAssets: true,
};
const READ_LIMIT = 64;

/** A host filesystem behind the project RPCs, with the server's failures as tagged errors. */
class FakeServer implements WorkspaceServer {
  readonly files = new Map<string, { contents: string; byteLength: number; version: number }>();
  readonly directories = new Set<string>();
  readonly ignored = new Set<string>();
  readonly writes: Array<{ path: string; expectedVersion: string | undefined }> = [];
  readonly watchers = new Map<string, { listener: WatchListener; disposed: boolean }>();
  private nextVersion = 1;
  enabled: Features;

  constructor(enabled: Features) {
    this.enabled = enabled;
  }

  /** The host, or an agent, changing a file behind the client's back. */
  put(path: string, contents: string) {
    this.putBytes(path, new TextEncoder().encode(contents));
  }

  /** A file the server reads as its readFile does: UTF-8, leniently, dropping a BOM. */
  putBytes(path: string, bytes: Uint8Array) {
    for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) {
      this.directories.add(parent);
    }
    const contents = new TextDecoder("utf-8").decode(bytes);
    this.files.set(path, { contents, byteLength: bytes.length, version: this.nextVersion++ });
  }

  features = async () => this.enabled;

  listEntries = async ({ cwd, directoryPath = "" }: ProjectListEntriesInput) => {
    const directory = resolve(cwd, directoryPath);
    if (!this.directories.has(directory)) {
      throw failure("ProjectListEntriesError", "directory_list_failed");
    }
    const children = [...this.directories, ...this.files.keys()]
      .filter((path) => dirname(path) === directory)
      .map((path): ProjectEntry => ({
        path: path.slice(cwd.length + 1),
        kind: this.directories.has(path) ? "directory" : "file",
        ignored: this.ignored.has(path),
      }));
    return { entries: children, truncated: false };
  };

  readFile = async ({ cwd, relativePath }: { cwd: string; relativePath: string }) => {
    const path = resolve(cwd, relativePath);
    const file = this.files.get(path);
    if (file === undefined) throw failure("ProjectReadFileError", "path_not_found");
    if (file.contents.includes("\0")) throw failure("ProjectReadFileError", "binary_file");
    const truncated = file.byteLength > READ_LIMIT;
    return {
      relativePath,
      contents: file.contents.slice(0, READ_LIMIT),
      byteLength: file.byteLength,
      truncated,
      ...(this.enabled.fileVersions && !truncated ? { version: `v${file.version}` } : {}),
    };
  };

  statEntry = async ({ cwd, relativePath }: { cwd: string; relativePath: string }) => {
    const path = resolve(cwd, relativePath);
    const file = this.files.get(path);
    if (file === undefined && !this.directories.has(path)) {
      throw failure("ProjectStatEntryError", "path_not_found");
    }
    return {
      relativePath,
      kind: file === undefined ? ("directory" as const) : ("file" as const),
      symlink: false,
      size: file?.byteLength ?? 0,
      mtimeMs: file?.version ?? 0,
      birthtimeMs: 0,
      version: `v${file?.version ?? 0}`,
    };
  };

  writeFile = async (input: {
    cwd: string;
    relativePath: string;
    contents: string;
    expectedVersion?: string | undefined;
  }) => {
    const path = resolve(input.cwd, input.relativePath);
    this.writes.push({ path, expectedVersion: input.expectedVersion });
    const current = this.files.get(path);
    if (
      this.enabled.fileVersions &&
      input.expectedVersion !== undefined &&
      input.expectedVersion !== `v${current?.version}`
    ) {
      throw failure("ProjectWriteFileError", "version_conflict");
    }
    this.put(path, input.contents);
    const version = this.enabled.fileVersions ? `v${this.files.get(path)?.version}` : undefined;
    return { relativePath: input.relativePath, ...(version === undefined ? {} : { version }) };
  };

  createDirectory = async ({ cwd, relativePath }: { cwd: string; relativePath: string }) => {
    this.directories.add(resolve(cwd, relativePath));
    return { relativePath };
  };

  deleteEntry = async (input: {
    cwd: string;
    relativePath: string;
    recursive?: boolean | undefined;
  }) => {
    const path = resolve(input.cwd, input.relativePath);
    const below = [...this.files.keys(), ...this.directories].filter((key) =>
      key.startsWith(`${path}/`),
    );
    if (below.length > 0 && input.recursive !== true) {
      throw failure("ProjectDeleteEntryError", "directory_not_empty");
    }
    for (const key of [path, ...below]) {
      this.files.delete(key);
      this.directories.delete(key);
    }
    return { relativePath: input.relativePath };
  };

  renameEntry = async (input: { cwd: string; relativePath: string; newRelativePath: string }) => {
    const from = resolve(input.cwd, input.relativePath);
    const to = resolve(input.cwd, input.newRelativePath);
    const file = this.files.get(from);
    if (file === undefined) throw failure("ProjectRenameEntryError", "path_not_found");
    if (this.files.has(to)) throw failure("ProjectRenameEntryError", "path_exists");
    this.files.delete(from);
    this.files.set(to, file);
    return { relativePath: input.newRelativePath };
  };

  searchEntries = async () => ({ entries: [], truncated: false });
  searchContents = async () => ({ matches: [], truncated: false });

  readAsset = async (cwd: string, relativePath: string) => {
    const file = this.files.get(resolve(cwd, relativePath));
    if (file === undefined) throw failure("AssetError", "path_not_found");
    return new TextEncoder().encode(file.contents);
  };

  watchEntries = (cwd: string, listener: WatchListener) => {
    const watcher = { listener, disposed: false };
    this.watchers.set(cwd, watcher);
    return { dispose: () => void (watcher.disposed = true) };
  };
}

function failure(tag: string, kind: string) {
  return { _tag: tag, failure: kind, message: `${tag}: ${kind}` };
}

function resolve(cwd: string, relativePath: string) {
  if (relativePath.startsWith("/")) return relativePath;
  return relativePath === "" || relativePath === "." ? cwd : `${cwd}/${relativePath}`;
}

function dirname(path: string) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

const ROOT = "/repo";
const OTHER_PROJECT = "/elsewhere";

function setup(enabled: Features, open: Array<string> = []) {
  const server = new FakeServer(enabled);
  server.directories.add(ROOT);
  server.directories.add(OTHER_PROJECT);
  server.put(`${ROOT}/src/a.ts`, "export const a = 1;\n");
  const changes: Array<Change> = [];
  const decorated: Array<string> = [];
  const readOnly: Array<[string, string]> = [];
  const files = new WorkspaceFiles(
    server,
    {
      roots: () => [ROOT],
      knownRoots: () => [ROOT, OTHER_PROJECT],
      openPaths: () => open,
      changed: (list) => void changes.push(...list),
      decorated: (paths) => void decorated.push(...paths),
      openedReadOnly: (path, reason) => void readOnly.push([path, reason]),
    },
    1_000,
  );
  return { server, files, changes, decorated, readOnly };
}

const text = (value: string) => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const SAVE = { create: true, overwrite: true };

/**
 * VS Code's own guard on a save: it refuses, offering Compare and Overwrite,
 * when the file stats newer than when the editor read it and at another size.
 */
function vscodeRefusesSave(read: Stat, now: Stat) {
  return read.mtime < now.mtime && read.size !== now.size;
}

async function rejection(promise: Promise<unknown>): Promise<FilesError> {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(error instanceof FilesError))
    throw new Error(`Expected a FilesError, got ${String(error)}`);
  return error;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceFiles on a stock server", () => {
  it("round-trips an edit, overwriting without a version", async () => {
    const { server, files, changes } = setup(STOCK);
    expect(decode(await files.readFile(`${ROOT}/src/a.ts`))).toBe("export const a = 1;\n");
    const before = await files.stat(`${ROOT}/src/a.ts`);

    await files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 2;\n"), SAVE);

    expect(server.files.get(`${ROOT}/src/a.ts`)?.contents).toBe("export const a = 2;\n");
    expect(server.writes).toEqual([{ path: `${ROOT}/src/a.ts`, expectedVersion: undefined }]);
    // VS Code's own modified-since check sees its write as the newest.
    expect((await files.stat(`${ROOT}/src/a.ts`)).mtime).toBeGreaterThan(before.mtime);
    expect(changes).toEqual([{ path: `${ROOT}/src/a.ts`, kind: "changed" }]);
  });

  it("synthesizes a stat from the parent's listing, greying ignored entries", async () => {
    const { server, files, decorated } = setup(STOCK);
    server.put(`${ROOT}/dist/out.js`, "");
    server.ignored.add(`${ROOT}/dist`);

    expect(await files.stat(ROOT)).toMatchObject({ kind: "directory", readonly: false });
    expect(await files.stat(`${ROOT}/src/a.ts`)).toMatchObject({ kind: "file", size: 0 });
    expect(await files.readDirectory(ROOT)).toEqual(
      expect.arrayContaining([
        ["src", "directory"],
        ["dist", "directory"],
      ]),
    );
    expect(files.isIgnored(`${ROOT}/dist`)).toBe(true);
    expect(decorated).toEqual([`${ROOT}/dist`]);
    expect((await rejection(files.stat(`${ROOT}/src/gone.ts`))).code).toBe("FileNotFound");
  });

  it("refuses to create, move or delete entries", async () => {
    const { server, files } = setup(STOCK);
    const refusals = await Promise.all([
      rejection(files.writeFile(`${ROOT}/src/new.ts`, text(""), SAVE)),
      rejection(files.createDirectory(`${ROOT}/lib`)),
      rejection(files.delete(`${ROOT}/src/a.ts`, { recursive: false })),
      rejection(files.rename(`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`)),
    ]);
    expect(refusals.map((error) => error.code)).toEqual([
      "NoPermissions",
      "NoPermissions",
      "NoPermissions",
      "NoPermissions",
    ]);
    expect([...server.files.keys()]).toEqual([`${ROOT}/src/a.ts`]);
  });

  it("refreshes an open file an agent changed at turn end, and only that one", async () => {
    const open = [`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`];
    const { server, files, changes } = setup(STOCK, open);
    server.put(`${ROOT}/src/b.ts`, "b\n");
    await files.readFile(`${ROOT}/src/a.ts`);
    await files.readFile(`${ROOT}/src/b.ts`);
    const before = await files.stat(`${ROOT}/src/a.ts`);

    server.put(`${ROOT}/src/a.ts`, "export const a = 3;\n");
    await files.refresh(ROOT);

    // An unchanged open file is not reported, so a dirty one meets no spurious conflict.
    expect(changes).toEqual([{ path: `${ROOT}/src/a.ts`, kind: "changed" }]);
    expect((await files.stat(`${ROOT}/src/a.ts`)).mtime).toBeGreaterThan(before.mtime);
    expect((await files.stat(`${ROOT}/src/b.ts`)).mtime).toBe(before.mtime);
  });

  it("reports an open file deleted on the host at turn end", async () => {
    const { server, files, changes } = setup(STOCK, [`${ROOT}/src/a.ts`]);
    await files.readFile(`${ROOT}/src/a.ts`);
    server.files.delete(`${ROOT}/src/a.ts`);
    await files.refresh(ROOT);
    expect(changes).toEqual([{ path: `${ROOT}/src/a.ts`, kind: "deleted" }]);
  });

  it("has VS Code refuse a stale save after a turn end, but not after its own write", async () => {
    const { server, files } = setup(STOCK, [`${ROOT}/src/a.ts`]);
    const read = await files.stat(`${ROOT}/src/a.ts`);
    await files.readFile(`${ROOT}/src/a.ts`);
    await files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 2;\n"), SAVE);
    const written = await files.stat(`${ROOT}/src/a.ts`);
    expect(vscodeRefusesSave(read, written)).toBe(true);
    expect(vscodeRefusesSave(written, await files.stat(`${ROOT}/src/a.ts`))).toBe(false);

    // An agent changes the file, same size, while the editor is dirty.
    server.put(`${ROOT}/src/a.ts`, "export const a = 9;\n");
    await files.refresh(ROOT);
    expect(vscodeRefusesSave(written, await files.stat(`${ROOT}/src/a.ts`))).toBe(true);
  });

  it("never stats a file deleted and made again as it was before", async () => {
    const { server, files } = setup(STOCK, [`${ROOT}/src/a.ts`]);
    await files.readFile(`${ROOT}/src/a.ts`);
    const read = await files.stat(`${ROOT}/src/a.ts`);
    server.files.delete(`${ROOT}/src/a.ts`);
    await files.refresh(ROOT);
    server.put(`${ROOT}/src/a.ts`, "export const a = 1;\n");
    expect(vscodeRefusesSave(read, await files.stat(`${ROOT}/src/a.ts`))).toBe(true);
  });

  it("cannot read a binary file", async () => {
    const { server, files } = setup(STOCK);
    server.put(`${ROOT}/logo.png`, "\0PNG");
    expect((await rejection(files.readFile(`${ROOT}/logo.png`))).code).toBe("Unavailable");
  });
});

describe("WorkspaceFiles on either server", () => {
  for (const [name, enabled] of [
    ["stock", STOCK],
    ["capable", CAPABLE],
  ] as const) {
    it(`refuses writes outside the folders and of non-UTF-8 bytes (${name})`, async () => {
      const { server, files } = setup(enabled);
      server.put(`${OTHER_PROJECT}/x.ts`, "x");

      // A cited file outside the folders reads, against its project root, and opens read-only.
      expect(decode(await files.readFile(`${OTHER_PROJECT}/x.ts`))).toBe("x");
      expect((await files.stat(`${OTHER_PROJECT}/x.ts`)).readonly).toBe(true);
      expect(
        (await rejection(files.writeFile(`${OTHER_PROJECT}/x.ts`, text("y"), SAVE))).code,
      ).toBe("NoPermissions");
      const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
      expect((await rejection(files.writeFile(`${ROOT}/src/a.ts`, latin1, SAVE))).code).toBe(
        "NoPermissions",
      );
      expect(server.writes).toEqual([]);
    });

    it(`opens a truncated file read-only and never writes it back (${name})`, async () => {
      vi.useFakeTimers();
      const { server, files, changes, readOnly } = setup(enabled, [`${ROOT}/big.txt`]);
      server.put(`${ROOT}/big.txt`, "x".repeat(READ_LIMIT * 2));

      expect((await files.readFile(`${ROOT}/big.txt`)).length).toBe(READ_LIMIT);
      expect(readOnly).toEqual([[`${ROOT}/big.txt`, "truncated"]]);
      vi.runAllTimers();
      // The open editor re-stats, and the stat says read-only.
      expect(changes).toEqual([{ path: `${ROOT}/big.txt`, kind: "changed" }]);
      expect((await files.stat(`${ROOT}/big.txt`)).readonly).toBe(true);
      expect((await rejection(files.writeFile(`${ROOT}/big.txt`, text("x"), SAVE))).code).toBe(
        "NoPermissions",
      );
      expect(server.writes).toEqual([]);
    });
  }
});

describe("WorkspaceFiles on either server, a file the server cannot read back exactly", () => {
  for (const [name, enabled] of [
    ["stock", STOCK],
    ["capable", CAPABLE],
  ] as const) {
    it(`opens Latin-1 and BOM files read-only and never writes them back (${name})`, async () => {
      const { server, files, readOnly } = setup(enabled);
      server.putBytes(`${ROOT}/latin1.txt`, new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
      server.putBytes(`${ROOT}/bom.txt`, new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));

      for (const path of [`${ROOT}/latin1.txt`, `${ROOT}/bom.txt`]) {
        await files.readFile(path);
        expect((await files.stat(path)).readonly).toBe(true);
        expect((await rejection(files.writeFile(path, text("a"), SAVE))).code).toBe(
          "NoPermissions",
        );
      }
      expect(readOnly).toEqual([
        [`${ROOT}/latin1.txt`, "lossy"],
        [`${ROOT}/bom.txt`, "lossy"],
      ]);
      expect(server.writes).toEqual([]);
    });
  }
});

describe("WorkspaceFiles on a server with the fork's features", () => {
  it("has VS Code refuse a save over a same-size change, and lets its Overwrite through", async () => {
    const { server, files } = setup(CAPABLE, [`${ROOT}/src/a.ts`]);
    const read = await files.stat(`${ROOT}/src/a.ts`);
    await files.readFile(`${ROOT}/src/a.ts`);
    server.put(`${ROOT}/src/a.ts`, "export const a = 9;\n");

    // VS Code stats before it writes; the size it sees differs, so it refuses.
    expect(vscodeRefusesSave(read, await files.stat(`${ROOT}/src/a.ts`))).toBe(true);
    // Overwrite: VS Code stats again and writes over the agent's version.
    await files.stat(`${ROOT}/src/a.ts`);
    await files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 2;\n"), SAVE);
    expect(server.files.get(`${ROOT}/src/a.ts`)?.contents).toBe("export const a = 2;\n");
  });

  it("fails a save over a change made after VS Code's last stat", async () => {
    const { server, files } = setup(CAPABLE, [`${ROOT}/src/a.ts`]);
    await files.readFile(`${ROOT}/src/a.ts`);
    await files.stat(`${ROOT}/src/a.ts`);
    server.put(`${ROOT}/src/a.ts`, "export const a = 'agent';\n");
    const error = await rejection(
      files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 'user';\n"), SAVE),
    );
    expect(error.message).toMatch(/changed on the host since Pult read it/);
    expect(server.files.get(`${ROOT}/src/a.ts`)?.contents).toBe("export const a = 'agent';\n");
  });

  it("round-trips an edit under the version it read, then the one it wrote", async () => {
    const { server, files } = setup(CAPABLE);
    const version = () => `v${server.files.get(`${ROOT}/src/a.ts`)?.version}`;
    await files.readFile(`${ROOT}/src/a.ts`);
    const read = version();
    await files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 2;\n"), SAVE);
    const written = version();
    await files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 3;\n"), SAVE);

    expect(server.files.get(`${ROOT}/src/a.ts`)?.contents).toBe("export const a = 3;\n");
    expect(server.writes.map((write) => write.expectedVersion)).toEqual([read, written]);
  });

  it("fails a save over a file changed since it was read, keeping the change", async () => {
    const { server, files } = setup(CAPABLE);
    await files.readFile(`${ROOT}/src/a.ts`);
    server.put(`${ROOT}/src/a.ts`, "export const a = 'agent';\n");

    const error = await rejection(
      files.writeFile(`${ROOT}/src/a.ts`, text("export const a = 'user';\n"), SAVE),
    );

    expect(error.message).toMatch(/changed on the host since Pult read it/);
    expect(server.files.get(`${ROOT}/src/a.ts`)?.contents).toBe("export const a = 'agent';\n");
  });

  it("stats through statEntry", async () => {
    const { server, files } = setup(CAPABLE);
    const stat = await files.stat(`${ROOT}/src/a.ts`);
    expect(stat).toMatchObject({ kind: "file", size: 20, readonly: false });
    expect(stat.mtime).toBe(server.files.get(`${ROOT}/src/a.ts`)?.version);
    expect((await files.stat(ROOT)).kind).toBe("directory");
  });

  it("creates, moves and deletes entries", async () => {
    const { server, files, changes } = setup(CAPABLE);
    await files.writeFile(`${ROOT}/src/b.ts`, text("b"), { create: true, overwrite: false });
    expect(
      (
        await rejection(
          files.writeFile(`${ROOT}/src/b.ts`, text("b"), { create: true, overwrite: false }),
        )
      ).code,
    ).toBe("FileExists");
    await files.rename(`${ROOT}/src/b.ts`, `${ROOT}/src/c.ts`);
    await files.createDirectory(`${ROOT}/lib`);
    expect((await rejection(files.delete(`${ROOT}/src`, { recursive: false }))).code).toBe(
      "Unknown",
    );
    await files.delete(`${ROOT}/src`, { recursive: true });

    expect([...server.files.keys()]).toEqual([]);
    expect(server.directories.has(`${ROOT}/lib`)).toBe(true);
    expect(changes).toEqual([
      { path: `${ROOT}/src/b.ts`, kind: "created" },
      { path: `${ROOT}/src/b.ts`, kind: "deleted" },
      { path: `${ROOT}/src/c.ts`, kind: "created" },
      { path: `${ROOT}/lib`, kind: "created" },
      { path: `${ROOT}/src`, kind: "deleted" },
    ]);
  });

  it("never deletes, moves or writes a workspace folder itself", async () => {
    const { files } = setup(CAPABLE);
    expect((await rejection(files.delete(ROOT, { recursive: true }))).code).toBe("NoPermissions");
    expect((await rejection(files.rename(ROOT, "/moved"))).code).toBe("NoPermissions");
  });

  it("reads a binary file's bytes over the asset route", async () => {
    const { server, files } = setup(CAPABLE);
    server.put(`${ROOT}/logo.png`, "\0PNG");
    expect(decode(await files.readFile(`${ROOT}/logo.png`))).toBe("\0PNG");
  });

  it("watches each folder once, reporting its changes", async () => {
    const { server, files, changes } = setup(CAPABLE, [`${ROOT}/src/a.ts`]);
    await files.syncWatches();
    await files.syncWatches();
    const watcher = server.watchers.get(ROOT);
    if (watcher === undefined) throw new Error("The folder is not watched.");
    expect(server.watchers.size).toBe(1);

    // Changes around the subscription may be missed: open files are re-stat'd.
    await watcher.listener.subscribed();
    const event: ProjectWatchEntriesEvent = {
      changes: [
        { path: "src/a.ts", kind: "changed" },
        { path: "src/new.ts", kind: "created" },
      ],
      truncated: false,
    };
    watcher.listener.changed(event);

    expect(changes).toEqual([
      { path: `${ROOT}/src/a.ts`, kind: "changed" },
      { path: `${ROOT}/src/a.ts`, kind: "changed" },
      { path: `${ROOT}/src/new.ts`, kind: "created" },
    ]);
  });

  it("marks a folder gone from the host and stops watching it", async () => {
    const { server, files, changes, decorated } = setup(CAPABLE);
    await files.syncWatches();
    server.watchers.get(ROOT)?.listener.gone();

    expect(files.isGone(ROOT)).toBe(true);
    expect(decorated).toEqual([ROOT]);
    expect(changes).toEqual([{ path: ROOT, kind: "deleted" }]);
    expect(server.watchers.get(ROOT)?.disposed).toBe(true);
    server.watchers.clear();
    await files.syncWatches();
    expect(server.watchers.size).toBe(0);
  });

  it("stops watching where the server does not advertise it", async () => {
    const { server, files } = setup(CAPABLE);
    await files.syncWatches();
    server.enabled = { ...CAPABLE, watchEntries: false };
    await files.syncWatches();
    expect(server.watchers.get(ROOT)?.disposed).toBe(true);
  });
});
