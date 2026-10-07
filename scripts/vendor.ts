#!/usr/bin/env node
// Vendors the protocol packages from T3 Code Extensible at the commit pinned in
// vendor/t3code/PIN, Pult's pin: packages/{contracts,client-runtime,shared} land
// verbatim in vendor/t3code/packages/, the fork's patches they rely on in
// vendor/t3code/patches/, the fork's `catalog:` block replaces this repo's in
// pnpm-workspace.yaml, and vendor/t3code/COMMIT records the full hash.
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

import { t3codeCheckoutPath } from "./checkout.ts";

const VENDORED_PACKAGES = ["contracts", "client-runtime", "shared"] as const;
// The fork's patches to dependencies the vendored code relies on: client-runtime
// uses the RPC client's `onPingTimeout` hook that the effect patch adds. A bump
// that renames one fails the checkout; rename it here and in pnpm-workspace.yaml.
const VENDORED_PATCHES = ["effect@4.0.1.patch", "@effect__vitest@4.0.1.patch"] as const;
const VENDOR_DIR = "vendor/t3code";
// Every vendored file sits under one of these, on both sides.
const VENDORED_DIRS = ["packages", "patches"] as const;
const VENDORED_PATHS = [
  ...VENDORED_PACKAGES.map((name) => `packages/${name}`),
  ...VENDORED_PATCHES.map((name) => `patches/${name}`),
];
const PINNED_PATHS = [...VENDORED_PATHS, "pnpm-workspace.yaml"];

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

// A top-level `catalog:` key and every line under it: indented lines, and
// blank lines followed by more of them.
const findCatalogBlock = (yaml: string) => {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^catalog:\s*$/.test(line));
  if (start === -1) return undefined;
  let end = start + 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s+\S/.test(line)) end = index + 1;
    else if (line.trim() !== "") break;
  }
  return { lines, start, end };
};

export function extractCatalogBlock(yaml: string): string | undefined {
  const block = findCatalogBlock(yaml);
  return block && block.lines.slice(block.start, block.end).join("\n");
}

/** This repo's pnpm-workspace.yaml with its `catalog:` block replaced by the fork's. */
export function replaceCatalogBlock(target: string, source: string): string | undefined {
  const sourceBlock = extractCatalogBlock(source);
  const block = findCatalogBlock(target);
  if (sourceBlock === undefined || block === undefined) return undefined;
  return [...block.lines.slice(0, block.start), sourceBlock, ...block.lines.slice(block.end)].join(
    "\n",
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

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/** Every difference between the vendored tree and the pinned fork, one line each. */
const findDrift = Effect.fn("findDrift")(function* (root: string, tree: string, commit: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const drift: Array<string> = [];

  const upstream = listFiles(yield* git(tree, ["ls-files", "-z", "--", ...VENDORED_PATHS]));
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
  for (const file of upstream) {
    const local = path.join(root, VENDOR_DIR, file);
    if (!vendored.delete(file) || !(yield* fs.exists(local))) {
      drift.push(`missing   ${VENDOR_DIR}/${file}`);
    } else if (!sameBytes(yield* fs.readFile(local), yield* fs.readFile(path.join(tree, file)))) {
      drift.push(`changed   ${VENDOR_DIR}/${file}`);
    }
  }
  for (const file of vendored) drift.push(`extra     ${VENDOR_DIR}/${file}`);

  const workspace = yield* fs.readFileString(path.join(root, "pnpm-workspace.yaml"));
  const forkWorkspace = yield* fs.readFileString(path.join(tree, "pnpm-workspace.yaml"));
  if (extractCatalogBlock(workspace) !== extractCatalogBlock(forkWorkspace)) {
    drift.push("changed   pnpm-workspace.yaml catalog");
  }

  const commitFile = path.join(root, VENDOR_DIR, "COMMIT");
  const recorded = (yield* fs.exists(commitFile))
    ? (yield* fs.readFileString(commitFile)).trim()
    : "";
  if (recorded !== commit) drift.push(`changed   ${VENDOR_DIR}/COMMIT (want ${commit})`);
  return drift;
});

const sync = Effect.fn("sync")(function* (root: string, tree: string, commit: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
  const files = listFiles(yield* git(tree, ["ls-files", "-z", "--", ...VENDORED_PATHS]));
  for (const file of files) {
    const destination = path.join(root, VENDOR_DIR, file);
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copyFile(path.join(tree, file), destination);
  }

  const workspaceFile = path.join(root, "pnpm-workspace.yaml");
  const workspace = replaceCatalogBlock(
    yield* fs.readFileString(workspaceFile),
    yield* fs.readFileString(path.join(tree, "pnpm-workspace.yaml")),
  );
  if (workspace === undefined) {
    return yield* new VendorError({
      detail: "This repo's or the fork's pnpm-workspace.yaml has no top-level catalog: block.",
    });
  }
  yield* fs.writeFileString(workspaceFile, workspace);
  yield* fs.writeFileString(path.join(root, VENDOR_DIR, "COMMIT"), `${commit}\n`);
  return files.length;
});

/** The vendored tree's drift from the pin; empty when it matches. */
export const checkVendored = Effect.fn("checkVendored")(function* (checkout: string) {
  const root = yield* repoRoot;
  const { tree, commit } = yield* pinnedTree(checkout, yield* readPin(root));
  return yield* findDrift(root, tree, commit);
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
            detail: `The vendored tree differs from the pin; run pnpm vendor:sync.\n${drift.join("\n")}`,
          });
        }
        yield* Effect.log(`${VENDOR_DIR} matches the pin.`);
        return;
      }
      const root = yield* repoRoot;
      const { tree, commit } = yield* pinnedTree(checkout, yield* readPin(root));
      const count = yield* sync(root, tree, commit);
      yield* Effect.log(
        `Vendored ${count} files from ${checkout} at ${commit}. Run pnpm i if the catalog or a manifest changed.`,
      );
    }).pipe(Effect.scoped),
).pipe(Command.withDescription("Vendor the protocol packages from T3 Code Extensible at the pin."));

if (import.meta.main) {
  Command.run(vendor, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
