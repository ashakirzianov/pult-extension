#!/usr/bin/env node
// Vendors the protocol packages from T3 Code Extensible at the commit pinned in
// vendor/t3code/PIN, Pult's pin: packages/{contracts,client-runtime,shared} land
// verbatim in vendor/t3code/packages/, and vendor/t3code/COMMIT records the full
// hash. pnpm-workspace.yaml takes the fork's `catalog:` block whole, and its
// `overrides:`, `packageExtensions:` and `patchedDependencies:` blocks kept to
// the packages pnpm-lock.yaml installs, the patches vendored in
// vendor/t3code/patches/. A bump that brings in a package one of them names
// needs a second sync after `pnpm i`; `pnpm vendor:check` says so.
// The checkout is PULT_T3CODE_CHECKOUT (environment or .env), by default
// ~/repos/t3code-extensible; the pin is read from a temporary worktree of it,
// so the checkout's own branch and working tree are never touched.
// A port of the Pult repo's scripts/pult/vendor.ts. Pult also vendors `ssh` and
// `tailscale`; they spawn processes and open sockets, which a web extension
// cannot, so they stay out.
//
//   pnpm vendor:sync     write the vendored tree
//   pnpm vendor:check    fail if the vendored tree differs from the pin
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as YAML from "yaml";

import { t3codeCheckoutPath } from "./checkout.ts";

const VENDORED_PACKAGES = ["contracts", "client-runtime", "shared"] as const;
const VENDOR_DIR = "vendor/t3code";
// Every vendored file sits under one of these, on both sides.
const VENDORED_DIRS = ["packages", "patches"] as const;
const PACKAGE_PATHS = VENDORED_PACKAGES.map((name) => `packages/${name}`);
const PINNED_PATHS = [...PACKAGE_PATHS, "patches", "pnpm-workspace.yaml"];
// The pnpm-workspace.yaml blocks that are the fork's.
const PINNED_BLOCKS = ["catalog", "overrides", "packageExtensions", "patchedDependencies"] as const;
type PinnedBlock = (typeof PINNED_BLOCKS)[number];

export class VendorError extends Schema.TaggedError<VendorError>()("VendorError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** The pin is the first line of vendor/t3code/PIN: a commit hash, full or abbreviated. */
export function parsePin(text: string): string | undefined {
  const pin = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return /^[0-9a-f]{7,40}$/i.test(pin) ? pin.toLowerCase() : undefined;
}

// A top-level `<key>:` block: the key line and every line under it, that is
// indented lines, and blank lines followed by more of them.
const findBlock = (yaml: string, key: string) => {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `${key}:`);
  if (start === -1) return { lines, start, end: start };
  let end = start + 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s+\S/.test(line)) end = index + 1;
    else if (line.trim() !== "") break;
  }
  return { lines, start, end };
};

export function extractBlock(yaml: string, key: string): string | undefined {
  const { lines, start, end } = findBlock(yaml, key);
  return start === -1 ? undefined : lines.slice(start, end).join("\n");
}

/** `yaml` with its `key` block replaced by `block`, appended if it has none, removed if `block` is undefined. */
export function replaceBlock(yaml: string, key: string, block: string | undefined): string {
  const { lines, start, end } = findBlock(yaml, key);
  if (start !== -1) {
    return [
      ...lines.slice(0, start),
      ...(block === undefined ? [] : [block]),
      ...lines.slice(end),
    ].join("\n");
  }
  return block === undefined ? yaml : `${yaml.trimEnd()}\n\n${block}\n`;
}

const entryKey = (line: string) => {
  const match = /^\s*(?:"([^"]*)"|'([^']*)'|([^:]+?))\s*:(?:\s|$)/.exec(line);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? line.trim();
};

const indentOf = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => line.trimStart().startsWith("#");

// A block's entries: each line at the entries' indentation starts one, with the
// comments right above it and the lines indented under it. Blank lines are dropped.
const blockEntries = (block: string) => {
  const lines = block
    .split("\n")
    .slice(1)
    .filter((line) => line.trim() !== "");
  const first = lines.find((line) => !isComment(line));
  const indent = first === undefined ? 0 : indentOf(first);
  const entries: Array<{ key: string; lines: Array<string> }> = [];
  let comments: Array<string> = [];
  for (const line of lines) {
    if (indentOf(line) > indent) entries.at(-1)?.lines.push(line);
    else if (isComment(line)) comments.push(line);
    else {
      entries.push({ key: entryKey(line), lines: [...comments, line] });
      comments = [];
    }
  }
  return entries;
};

/** The package a selector names first: `a` in `a>b`, `name` in `name@range`. */
export const selectedPackage = (selector: string) =>
  selector.split(">", 1)[0]!.replace(/(?<=.)@.*$/, "");

const Dependencies = Schema.optional(Schema.Record(Schema.String, Schema.Unknown));
// An importer's dependencies, or a snapshot's; snapshots carry no devDependencies.
const DependencyMaps = Schema.Struct({
  dependencies: Dependencies,
  devDependencies: Dependencies,
  optionalDependencies: Dependencies,
});
const Lockfile = Schema.Struct({
  importers: Schema.optional(Schema.Record(Schema.String, DependencyMaps)),
  packages: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  snapshots: Schema.optional(Schema.Record(Schema.String, DependencyMaps)),
});

/** Every package pnpm-lock.yaml installs, by its name and by any alias it is installed as. */
export function installedPackages(lockfile: string): ReadonlySet<string> {
  const {
    importers = {},
    packages = {},
    snapshots = {},
  } = Schema.decodeUnknownSync(Lockfile)(YAML.parse(lockfile));
  const names = new Set(Object.keys(packages).map(selectedPackage));
  for (const { dependencies = {}, devDependencies = {}, optionalDependencies = {} } of [
    ...Object.values(importers),
    ...Object.values(snapshots),
  ]) {
    for (const name of Object.keys({
      ...dependencies,
      ...devDependencies,
      ...optionalDependencies,
    })) {
      names.add(name);
    }
  }
  return names;
}

/**
 * The fork's pnpm-workspace.yaml blocks as this repo carries them: the catalog
 * whole; the overrides, package extensions and patches for the packages in
 * `installed`, the patches at their vendored paths. `patches` are the fork's
 * patch files to vendor. An empty block is undefined.
 */
export function pinnedWorkspace(forkWorkspace: string, installed: ReadonlySet<string>) {
  const patches: Array<string> = [];
  const keep = (key: Exclude<PinnedBlock, "catalog">, rewrite = (line: string) => line) => {
    const block = extractBlock(forkWorkspace, key);
    const entries = (block === undefined ? [] : blockEntries(block)).filter((entry) =>
      installed.has(selectedPackage(entry.key)),
    );
    if (entries.length === 0) return undefined;
    return [`${key}:`, ...entries.flatMap((entry) => entry.lines.map(rewrite))].join("\n");
  };
  const blocks: Record<PinnedBlock, string | undefined> = {
    catalog: extractBlock(forkWorkspace, "catalog"),
    overrides: keep("overrides"),
    packageExtensions: keep("packageExtensions"),
    patchedDependencies: keep("patchedDependencies", (line) =>
      line.replace(
        /^(\s*(?:"[^"]*"|'[^']*'|[^\s#"'][^:]*?)\s*:\s*)(["']?)([^"'\s#]+)\2/,
        (_, prefix: string, quote: string, file: string) => {
          patches.push(file);
          return `${prefix}${quote}${VENDOR_DIR}/${file}${quote}`;
        },
      ),
    ),
  };
  return { blocks, patches };
}

/** The blocks of this repo's pnpm-workspace.yaml that differ from `blocks`, one line each. */
export function workspaceDrift(
  workspace: string,
  blocks: Record<PinnedBlock, string | undefined>,
): Array<string> {
  return PINNED_BLOCKS.filter((key) => extractBlock(workspace, key) !== blocks[key]).map(
    (key) => `changed   pnpm-workspace.yaml ${key}`,
  );
}

const repoRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dirname, "..");
});

const git = Effect.fn("git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make("git", [...args], { cwd, stderr: "inherit" }),
  );
  const [stdout, exitCode] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0) {
    return yield* new VendorError({
      detail: `git ${args.join(" ")} exited with code ${exitCode} in ${cwd}.`,
    });
  }
  return stdout;
}, Effect.scoped);

const resolveCheckout = Effect.fn("resolveCheckout")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkout = t3codeCheckoutPath();
  if (!(yield* fs.exists(path.join(checkout, ".git")))) {
    return yield* new VendorError({
      detail: `No T3 Code Extensible checkout at ${checkout}. Set PULT_T3CODE_CHECKOUT, in the environment or .env.`,
    });
  }
  return checkout;
});

const readPin = Effect.fn("readPin")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, VENDOR_DIR, "PIN");
  const pin = parsePin(yield* fs.readFileString(file));
  if (pin === undefined) {
    return yield* new VendorError({ detail: `${file} does not start with a commit hash.` });
  }
  return pin;
});

/** A detached worktree of the checkout at the pin, removed when the scope closes. */
const pinnedTree = Effect.fn("pinnedTree")(function* (checkout: string, pin: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commit = (yield* git(checkout, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${pin}^{commit}`,
  ]).pipe(
    Effect.mapError(
      () =>
        new VendorError({
          detail: `${checkout} has no commit ${pin}; fetch it there first.`,
        }),
    ),
  )).trim();
  const tree = path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "pult-extension-vendor-" }),
    "t3code",
  );
  yield* Effect.acquireRelease(
    git(checkout, ["worktree", "add", "--quiet", "--detach", "--no-checkout", tree, commit]),
    () => git(checkout, ["worktree", "remove", "--force", tree]).pipe(Effect.ignore),
  );
  // Only the paths vendoring reads are checked out; the rest of the fork stays in git.
  yield* git(tree, ["checkout", "--quiet", commit, "--", ...PINNED_PATHS]);
  return { tree, commit };
});

const listFiles = (output: string) => output.split("\0").filter((file) => file.length > 0);

/** The fork at the pin as this repo vendors it: the files, and the pnpm-workspace.yaml blocks. */
const pinnedSource = Effect.fn("pinnedSource")(function* (root: string, checkout: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { tree, commit } = yield* pinnedTree(checkout, yield* readPin(root));
  const { blocks, patches } = pinnedWorkspace(
    yield* fs.readFileString(path.join(tree, "pnpm-workspace.yaml")),
    installedPackages(yield* fs.readFileString(path.join(root, "pnpm-lock.yaml"))),
  );
  const files = listFiles(yield* git(tree, ["ls-files", "-z", "--", ...PACKAGE_PATHS, ...patches]));
  return { tree, commit, files, blocks };
});

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/** The vendored tree's drift from the pin, one line each; empty when it matches. */
export const checkVendored = Effect.fn("checkVendored")(function* (checkout: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* repoRoot;
  const { tree, commit, files, blocks } = yield* pinnedSource(root, checkout);
  const drift: Array<string> = [];

  // This repo's side as git would commit it: tracked and untracked files, minus ignored ones.
  const vendored = new Set(
    listFiles(
      yield* git(root, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ...VENDORED_DIRS.map((dir) => `${VENDOR_DIR}/${dir}`),
      ]),
    ).map((file) => file.slice(VENDOR_DIR.length + 1)),
  );
  for (const file of files) {
    const local = path.join(root, VENDOR_DIR, file);
    if (!vendored.delete(file) || !(yield* fs.exists(local))) {
      drift.push(`missing   ${VENDOR_DIR}/${file}`);
    } else if (!sameBytes(yield* fs.readFile(local), yield* fs.readFile(path.join(tree, file)))) {
      drift.push(`changed   ${VENDOR_DIR}/${file}`);
    }
  }
  for (const file of vendored) drift.push(`extra     ${VENDOR_DIR}/${file}`);

  drift.push(
    ...workspaceDrift(yield* fs.readFileString(path.join(root, "pnpm-workspace.yaml")), blocks),
  );

  const commitFile = path.join(root, VENDOR_DIR, "COMMIT");
  const recorded = (yield* fs.exists(commitFile))
    ? (yield* fs.readFileString(commitFile)).trim()
    : "";
  if (recorded !== commit) drift.push(`changed   ${VENDOR_DIR}/COMMIT (want ${commit})`);
  return drift;
}, Effect.scoped);

const sync = Effect.fn("sync")(function* (checkout: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* repoRoot;
  const { tree, commit, files, blocks } = yield* pinnedSource(root, checkout);
  const target = path.join(root, VENDOR_DIR, "packages");

  for (const name of VENDORED_PACKAGES) {
    const dir = path.join(target, name);
    // Replace everything but the install's node_modules, so deletions carry.
    if (yield* fs.exists(dir)) {
      for (const entry of yield* fs.readDirectory(dir)) {
        if (entry !== "node_modules") yield* fs.remove(path.join(dir, entry), { recursive: true });
      }
    }
  }
  yield* fs.remove(path.join(root, VENDOR_DIR, "patches"), { recursive: true, force: true });
  for (const file of files) {
    const destination = path.join(root, VENDOR_DIR, file);
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copyFile(path.join(tree, file), destination);
  }

  const workspaceFile = path.join(root, "pnpm-workspace.yaml");
  yield* fs.writeFileString(
    workspaceFile,
    PINNED_BLOCKS.reduce(
      (workspace, key) => replaceBlock(workspace, key, blocks[key]),
      yield* fs.readFileString(workspaceFile),
    ),
  );
  yield* fs.writeFileString(path.join(root, VENDOR_DIR, "COMMIT"), `${commit}\n`);
  return { count: files.length, commit };
}, Effect.scoped);

const vendor = Command.make(
  "vendor",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Report drift from the pin and fail on any, without writing."),
      Flag.withDefault(false),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const checkout = yield* resolveCheckout();
      if (flags.check) {
        const drift = yield* checkVendored(checkout);
        if (drift.length > 0) {
          return yield* new VendorError({
            detail: `The vendored tree differs from the pin; run pnpm vendor:sync, then pnpm i.\n${drift.join("\n")}`,
          });
        }
        yield* Effect.log(`${VENDOR_DIR} matches the pin.`);
        return;
      }
      const { count, commit } = yield* sync(checkout);
      yield* Effect.log(
        `Vendored ${count} files from ${checkout} at ${commit}. Run pnpm i, then pnpm vendor:check.`,
      );
    }),
).pipe(Command.withDescription("Vendor the protocol packages from T3 Code Extensible at the pin."));

if (import.meta.main) {
  Command.run(vendor, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
