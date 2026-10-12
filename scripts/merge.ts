#!/usr/bin/env node
// The tracked copy of the fork's thread view (`DECISIONS.md`, `thread-view-source`):
// extension/webview/t3/ holds the files of the fork's apps/web that the thread
// bundle's entry (extension/webview/src/) reaches, at the commit recorded in
// extension/webview/t3/UPSTREAM. Unlike vendor/, the copy takes small edits
// (extension/webview/t3/EDITS.md), so a pin bump merges rather than overwrites:
// each copied file gets upstream's change between the recorded commit and the
// pin by a three-way merge, conflicts are left marked for a human, files the
// entry now reaches are added, and unedited files it no longer reaches go.
//
//   pnpm vendor:merge     merge upstream's apps/web at the pin into the copy
//   pnpm vendor:check     also fails while the copy is at another commit
import * as NodeFS from "node:fs";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { STUBS } from "../extension/webview/stubs.ts";
import {
  git,
  parsePin,
  pinnedTree,
  readPin,
  repoRoot,
  resolveCheckout,
  VendorError,
} from "./vendor.ts";

const WEBVIEW = "extension/webview";
const COPY = `${WEBVIEW}/t3`;
const OURS = `${WEBVIEW}/src`;
const UPSTREAM_APP = "apps/web";
const RECORD = `${COPY}/UPSTREAM`;
// Files of ours inside the copy's directory, not upstream's.
const COPY_OWN_FILES = new Set(["UPSTREAM", "EDITS.md"]);

const CODE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".json", ".css"];
const RESOLVE_SUFFIXES = [".ts", ".tsx", ".d.ts", ".js", "/index.ts", "/index.tsx"];

/** Whether a path is source, which tsc and the merge read, rather than an asset the bundle ships. */
export function isCode(file: string): boolean {
  return CODE_EXTENSIONS.some((extension) => file.endsWith(extension));
}

const JS_PATTERNS = [
  // import … from "x", import "x", export … from "x", across lines
  /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/g,
  /(?:^|[^\w$.])import\(\s*["']([^"'\n]+)["']\s*\)/g,
  /new\s+URL\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)/g,
];
const CSS_PATTERNS = [
  /@import\s+(?:url\()?["']([^"'\n]+)["']/g,
  /url\(\s*["']?(?!data:|#|https?:)([^"')\s]+)["']?\s*\)/g,
];

/** The module specifiers a source file names, type-only imports included. */
export function importSpecifiers(source: string, file: string): Array<string> {
  const patterns = file.endsWith(".css") ? CSS_PATTERNS : JS_PATTERNS;
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]!.split("?")[0]!),
  );
}

/**
 * The file a specifier names, in the layout the copy is resolved in: our files
 * under extension/webview/src, upstream's under extension/webview/t3, with
 * `~/` for the copy's src/. Package imports resolve to null.
 */
export function resolveSpecifier(
  from: string,
  specifier: string,
  exists: (file: string) => boolean,
): string | null {
  let base: string;
  if (specifier.startsWith("~/")) base = `${COPY}/src/${specifier.slice(2)}`;
  else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const segments = from.split("/").slice(0, -1);
    for (const segment of specifier.split("/")) {
      if (segment === "..") segments.pop();
      else if (segment !== ".") segments.push(segment);
    }
    base = segments.join("/");
  } else return null;
  return [base, ...RESOLVE_SUFFIXES.map((suffix) => base + suffix)].find(exists) ?? null;
}

export interface Closure {
  /** Copy paths, relative to the copy, that tsc or the bundle reads. */
  readonly files: ReadonlySet<string>;
  /** Relative imports that named no file, as `from: specifier`. */
  readonly unresolved: ReadonlyArray<string>;
}

/**
 * The copy's files the entry reaches. Source is followed through stubbed
 * modules too, since tsc still reads them; an asset counts only where the
 * bundle reaches it, past no stub.
 */
export function closure(input: {
  readonly roots: ReadonlyArray<string>;
  readonly read: (file: string) => string;
  readonly exists: (file: string) => boolean;
  readonly stubs: ReadonlySet<string>;
}): Closure {
  const files = new Set<string>();
  const unresolved: Array<string> = [];
  const seen = new Map<string, boolean>();
  const queue = input.roots.map((file) => ({ file, live: true }));
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { file, live } = next;
    if (seen.get(file) === true || (seen.has(file) && !live)) continue;
    seen.set(file, live);
    if (file.startsWith(`${COPY}/`)) {
      const relative = file.slice(COPY.length + 1);
      if (live || isCode(relative)) files.add(relative);
    }
    if (!isCode(file) || file.endsWith(".json")) continue;
    const source = input.read(file);
    for (const specifier of importSpecifiers(source, file)) {
      const target = resolveSpecifier(file, specifier, input.exists);
      if (target === null) {
        if (specifier.startsWith(".") || specifier.startsWith("~/")) {
          unresolved.push(`${file}: ${specifier}`);
        }
        continue;
      }
      const stubbed = input.stubs.has(target.slice(COPY.length + 1));
      queue.push({ file: target, live: live && !stubbed });
    }
  }
  return { files, unresolved };
}

const BINARY = /\.(wasm|woff2?|ttf|otf|png|jpe?g|gif|webp|ico|mp3|wav|glb)$/;

export type MergeOutcome =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Write"; readonly content: Uint8Array }
  | { readonly _tag: "Conflict"; readonly content: Uint8Array; readonly detail: string };

const sameBytes = (left: Uint8Array | undefined, right: Uint8Array | undefined) =>
  left !== undefined &&
  right !== undefined &&
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const run = Effect.fn("run")(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { stderr: "inherit" }));
  const [stdout, exitCode] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
    { concurrency: "unbounded" },
  );
  return { stdout, exitCode };
}, Effect.scoped);

/** Upstream's change from `base` to `theirs` applied to `ours`, the copy's file. */
const mergeFile = Effect.fn("mergeFile")(function* (
  file: string,
  ours: Uint8Array,
  base: Uint8Array | undefined,
  theirs: Uint8Array,
  labels: { readonly base: string; readonly theirs: string },
) {
  if (sameBytes(ours, theirs)) return { _tag: "Unchanged" } as MergeOutcome;
  if (sameBytes(ours, base)) return { _tag: "Write", content: theirs } as MergeOutcome;
  if (sameBytes(base, theirs)) return { _tag: "Unchanged" } as MergeOutcome;
  if (base === undefined || BINARY.test(file)) {
    return {
      _tag: "Conflict",
      content: ours,
      detail: "edited here and changed upstream; kept the copy's",
    } as MergeOutcome;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pult-extension-merge-" });
  const [oursFile, baseFile, theirsFile] = ["ours", "base", "theirs"].map((name) =>
    path.join(dir, name),
  );
  yield* fs.writeFile(oursFile!, ours);
  yield* fs.writeFile(baseFile!, base);
  yield* fs.writeFile(theirsFile!, theirs);
  const { stdout, exitCode } = yield* run("git", [
    "merge-file",
    "-p",
    "-L",
    "copy",
    "-L",
    labels.base,
    "-L",
    labels.theirs,
    oursFile!,
    baseFile!,
    theirsFile!,
  ]);
  if (exitCode < 0 || exitCode > 127) {
    return yield* new VendorError({ detail: `git merge-file failed on ${file}.` });
  }
  const content = new TextEncoder().encode(stdout);
  return (
    exitCode === 0
      ? { _tag: "Write", content }
      : { _tag: "Conflict", content, detail: `${exitCode} conflicts, marked in the file` }
  ) as MergeOutcome;
}, Effect.scoped);

const readRecord = Effect.fn("readRecord")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, RECORD);
  return (yield* fs.exists(file)) ? parsePin(yield* fs.readFileString(file)) : undefined;
});

/** Every file under `dir`, relative to it. */
const listTree = Effect.fn("listTree")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(dir))) return [] as Array<string>;
  return (yield* fs.readDirectory(dir, { recursive: true })).filter(
    (file) => !file.split("/").includes("node_modules") && isFile(path.join(dir, file)),
  );
});

// The closure walk is synchronous; it reads our side of the working tree directly.
const isFile = (file: string) => NodeFS.existsSync(file) && NodeFS.statSync(file).isFile();
const readText = (file: string) => NodeFS.readFileSync(file, "utf8");

const merge = Effect.fn("merge")(function* (checkout: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* repoRoot;
  const recorded = yield* readRecord(root);
  const { tree: theirsTree, commit } = yield* pinnedTree(checkout, yield* readPin(root), [
    UPSTREAM_APP,
  ]);
  const baseTree =
    recorded === undefined
      ? undefined
      : (yield* pinnedTree(checkout, recorded, [UPSTREAM_APP])).tree;
  const upstreamFile = (tree: string, file: string) => path.join(tree, UPSTREAM_APP, file);
  const readOptional = (file: string) =>
    fs
      .exists(file)
      .pipe(Effect.flatMap((exists) => (exists ? fs.readFile(file) : Effect.succeed(undefined))));

  // 1. Upstream's change, merged into every file the copy holds.
  const copyDir = path.join(root, COPY);
  const copied = (yield* listTree(copyDir)).filter((file) => !COPY_OWN_FILES.has(file));
  const merged = new Map<string, Uint8Array>();
  const conflicts: Array<string> = [];
  const upstreamDeleted: Array<string> = [];
  for (const file of copied) {
    const ours = yield* fs.readFile(path.join(copyDir, file));
    const base =
      baseTree === undefined ? undefined : yield* readOptional(upstreamFile(baseTree, file));
    const theirs = yield* readOptional(upstreamFile(theirsTree, file));
    if (theirs === undefined) {
      upstreamDeleted.push(file);
      merged.set(file, ours);
      continue;
    }
    const outcome = yield* mergeFile(file, ours, base, theirs, {
      base: recorded ?? "none",
      theirs: commit,
    });
    if (outcome._tag === "Conflict") conflicts.push(`${file}: ${outcome.detail}`);
    merged.set(file, outcome._tag === "Unchanged" ? ours : outcome.content);
  }

  // 2. What the entry reaches, read through the merged copy and upstream's new files.
  const copyPath = (file: string) => file.slice(COPY.length + 1);
  const theirsHas = new Set(
    (yield* listTree(path.join(theirsTree, UPSTREAM_APP))).map((file) => `${COPY}/${file}`),
  );
  const decoder = new TextDecoder();
  const exists = (file: string) =>
    file.startsWith(`${COPY}/`)
      ? merged.has(copyPath(file)) || theirsHas.has(file)
      : isFile(path.join(root, file));
  const read = (file: string) => {
    if (!file.startsWith(`${COPY}/`)) return readText(path.join(root, file));
    const local = merged.get(copyPath(file));
    return local !== undefined
      ? decoder.decode(local)
      : readText(upstreamFile(theirsTree, copyPath(file)));
  };
  const roots = [
    ...(yield* listTree(path.join(root, OURS))).map((file) => `${OURS}/${file}`),
    // Ambient declarations reach no file by import; tsc reads them all.
    ...[...theirsHas].filter((file) => file.startsWith(`${COPY}/src/`) && file.endsWith(".d.ts")),
  ];
  const reached = closure({ roots, read, exists, stubs: new Set(Object.keys(STUBS)) });

  // 3. Write the copy: reached files, merged or new; unreached ones go unless edited.
  const kept: Array<string> = [];
  let added = 0;
  let removed = 0;
  let updated = 0;
  for (const file of reached.files) {
    const target = path.join(copyDir, file);
    const content = merged.get(file) ?? (yield* fs.readFile(upstreamFile(theirsTree, file)));
    const current = yield* readOptional(target);
    if (sameBytes(current, content)) continue;
    if (current === undefined) added += 1;
    else updated += 1;
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFile(target, content);
  }
  for (const file of merged.keys()) {
    if (reached.files.has(file)) continue;
    const base =
      baseTree === undefined ? undefined : yield* readOptional(upstreamFile(baseTree, file));
    const ours = yield* fs.readFile(path.join(copyDir, file));
    if (base !== undefined && !sameBytes(ours, base) && !upstreamDeleted.includes(file)) {
      kept.push(file);
      continue;
    }
    yield* fs.remove(path.join(copyDir, file));
    removed += 1;
  }
  yield* fs.writeFileString(path.join(root, RECORD), `${commit}\n`);

  // Upstream's dependencies are the bundle's: a change there is a change to extension/package.json.
  const packageChanged =
    baseTree !== undefined &&
    !sameBytes(
      yield* readOptional(upstreamFile(baseTree, "package.json")),
      yield* readOptional(upstreamFile(theirsTree, "package.json")),
    );
  return {
    commit,
    recorded,
    files: reached.files.size,
    added,
    updated,
    removed,
    conflicts,
    kept,
    upstreamDeleted: upstreamDeleted.filter((file) => reached.files.has(file)),
    unresolved: reached.unresolved,
    packageChanged,
  };
}, Effect.scoped);

/** Whether the copy is at the pin; empty when it is. */
export const checkCopy = Effect.fn("checkCopy")(function* (checkout: string) {
  const root = yield* repoRoot;
  const recorded = yield* readRecord(root);
  const pin = (yield* git(checkout, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${yield* readPin(root)}^{commit}`,
  ])).trim();
  return recorded === pin
    ? []
    : [
        `changed   ${RECORD} (at ${recorded ?? "nothing"}, the pin is ${pin}); run pnpm vendor:merge`,
      ];
});

const command = Command.make(
  "merge",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Fail unless the copy is at the pin, without writing."),
      Flag.withDefault(false),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const checkout = yield* resolveCheckout();
      if (flags.check) {
        const drift = yield* checkCopy(checkout);
        if (drift.length > 0) return yield* new VendorError({ detail: drift.join("\n") });
        yield* Effect.log(`${COPY} is at the pin.`);
        return;
      }
      const result = yield* merge(checkout);
      const lines = [
        `${COPY}: ${result.recorded ?? "nothing"} -> ${result.commit}, ${result.files} files (${result.added} added, ${result.updated} updated, ${result.removed} removed).`,
        ...result.conflicts.map((line) => `conflict  ${line}`),
        ...result.kept.map((file) => `kept      ${file}: no longer reached, but edited here`),
        ...result.upstreamDeleted.map(
          (file) => `deleted   ${file}: gone upstream but still reached`,
        ),
        ...result.unresolved.map((line) => `missing   ${line}`),
        ...(result.packageChanged
          ? ["changed   apps/web/package.json upstream: bring extension/package.json along"]
          : []),
      ];
      yield* Effect.log(lines.join("\n"));
    }),
).pipe(Command.withDescription("Merge upstream's thread view at the pin into the tracked copy."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
