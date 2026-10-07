import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  checkVendored,
  extractBlock,
  installedPackages,
  parsePin,
  pinnedWorkspace,
  replaceBlock,
  selectedPackage,
  workspaceDrift,
} from "./vendor.ts";
import { t3codeCheckoutPath } from "./checkout.ts";

describe("parsePin", () => {
  it("reads the hash on the first line and ignores the rest", () => {
    assert.strictEqual(parsePin("B98FD8AD27\nbump for plugin routes\n"), "b98fd8ad27");
    assert.strictEqual(
      parsePin("  b98fd8ad27f67791fa9eef2fdbddad60f5bca1a3  \r\n"),
      "b98fd8ad27f67791fa9eef2fdbddad60f5bca1a3",
    );
  });

  it("refuses anything that is not a commit hash", () => {
    assert.strictEqual(parsePin(""), undefined);
    assert.strictEqual(parsePin("main\n"), undefined);
    assert.strictEqual(parsePin("abc12\n"), undefined);
    assert.strictEqual(parsePin("\nb98fd8ad27\n"), undefined);
  });
});

describe("workspace blocks", () => {
  const ours = [
    "packages:",
    "  - apps/*",
    "",
    "catalog:",
    '  "@types/node": 24.12.4',
    "  effect: 4.0.0",
    "",
    "  # kept apart",
    "  vite-plus: 1.0.0",
    "",
    "# Comment on overrides.",
    "overrides:",
    '  effect: "catalog:"',
    "",
  ].join("\n");
  const catalog = "catalog:\n  effect: 4.0.1\n  jose: 6.2.2";

  it("takes the whole block, through blank lines, up to the next top-level line", () => {
    assert.strictEqual(
      extractBlock(ours, "catalog"),
      'catalog:\n  "@types/node": 24.12.4\n  effect: 4.0.0\n\n  # kept apart\n  vite-plus: 1.0.0',
    );
    assert.strictEqual(extractBlock(ours, "overrides"), 'overrides:\n  effect: "catalog:"');
    assert.strictEqual(extractBlock(ours, "patchedDependencies"), undefined);
  });

  it("replaces only the block, keeping everything around it", () => {
    assert.strictEqual(
      replaceBlock(ours, "catalog", catalog),
      [
        "packages:",
        "  - apps/*",
        "",
        "catalog:",
        "  effect: 4.0.1",
        "  jose: 6.2.2",
        "",
        "# Comment on overrides.",
        "overrides:",
        '  effect: "catalog:"',
        "",
      ].join("\n"),
    );
  });

  it("is a no-op when the block already matches", () => {
    assert.strictEqual(replaceBlock(ours, "catalog", extractBlock(ours, "catalog")), ours);
    assert.strictEqual(replaceBlock(ours, "patchedDependencies", undefined), ours);
  });

  it("appends a block the file lacks and removes one the fork lacks", () => {
    const patched = replaceBlock(ours, "patchedDependencies", "patchedDependencies:\n  a@1.0.0: x");
    assert.isTrue(patched.endsWith('  effect: "catalog:"\n\npatchedDependencies:\n  a@1.0.0: x\n'));
    assert.strictEqual(
      replaceBlock(ours, "overrides", undefined),
      ours.replace('overrides:\n  effect: "catalog:"\n', ""),
    );
  });
});

describe("selectedPackage", () => {
  it("names the package a selector starts from", () => {
    assert.strictEqual(selectedPackage("effect"), "effect");
    assert.strictEqual(selectedPackage("effect@4.0.1"), "effect");
    assert.strictEqual(selectedPackage("@effect/vitest@*"), "@effect/vitest");
    assert.strictEqual(selectedPackage("@effect/vitest>vitest"), "@effect/vitest");
    assert.strictEqual(selectedPackage("undici@^8"), "undici");
    assert.strictEqual(selectedPackage("@pierre/diffs@1.3.0-beta.10"), "@pierre/diffs");
  });
});

describe("installedPackages", () => {
  it("names every package, aliases included, and nothing the lockfile does not install", () => {
    const lockfile = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    devDependencies:",
      "      vite-plus:",
      "        specifier: 1.0.0",
      "        version: 1.0.0",
      "  extension:",
      "    dependencies:",
      "      '@t3tools/contracts':",
      "        specifier: workspace:*",
      "        version: link:../vendor/t3code/packages/contracts",
      "packages:",
      "  '@voidzero-dev/vite-plus-core@1.0.0':",
      "    resolution: {integrity: sha512-x}",
      "  vitest@5.0.1:",
      "    resolution: {integrity: sha512-y}",
      "snapshots:",
      "  '@voidzero-dev/vite-plus-core@1.0.0': {}",
      "  vitest@5.0.1(@types/node@24.12.4):",
      "    dependencies:",
      "      vite: '@voidzero-dev/vite-plus-core@1.0.0'",
      "    optionalDependencies:",
      "      fsevents: 2.3.3",
      "",
    ].join("\n");
    assert.deepStrictEqual([...installedPackages(lockfile)].toSorted(), [
      "@t3tools/contracts",
      "@voidzero-dev/vite-plus-core",
      "fsevents",
      "vite",
      "vite-plus",
      "vitest",
    ]);
  });
});

const forkWorkspace = [
  "packages:",
  "  - apps/*",
  "",
  "catalog:",
  "  effect: 4.0.1",
  "  react: 19.3.0",
  "",
  "overrides:",
  "  # Not ours.",
  '  "@clerk/clerk-js>@base-org/account": "-"',
  '  "@effect/vitest>vitest": "-"',
  "  # Ranges otherwise settle on two patch releases.",
  '  "undici@^8": "catalog:"',
  "  react: 19.3.0",
  '  effect: "catalog:"',
  "",
  "packageExtensions:",
  '  "@clerk/expo@*":',
  "    dependencies:",
  '      "@expo/config-plugins": 58.0.4',
  "  # Our patch makes @effect/vitest import vite-plus/test.",
  '  "@effect/vitest@*":',
  "    dependencies:",
  '      vite-plus: "catalog:"',
  "",
  "patchedDependencies:",
  "  alchemy@2.0.0-beta.80: patches/alchemy@2.0.0-beta.80.patch",
  '  "@effect/vitest@4.0.1": patches/@effect__vitest@4.0.1.patch',
  "  # A comment on a patch.",
  '  effect@4.0.1: "patches/effect@4.0.1.patch"',
  "",
].join("\n");
const installed = new Set(["@effect/vitest", "effect", "undici", "vite-plus"]);

describe("pinnedWorkspace", () => {
  const { blocks, patches } = pinnedWorkspace(forkWorkspace, installed);

  it("takes the catalog whole", () => {
    assert.strictEqual(blocks.catalog, "catalog:\n  effect: 4.0.1\n  react: 19.3.0");
  });

  it("keeps the overrides and extensions for installed packages, with their comments", () => {
    assert.strictEqual(
      blocks.overrides,
      [
        "overrides:",
        '  "@effect/vitest>vitest": "-"',
        "  # Ranges otherwise settle on two patch releases.",
        '  "undici@^8": "catalog:"',
        '  effect: "catalog:"',
      ].join("\n"),
    );
    assert.strictEqual(
      blocks.packageExtensions,
      [
        "packageExtensions:",
        "  # Our patch makes @effect/vitest import vite-plus/test.",
        '  "@effect/vitest@*":',
        "    dependencies:",
        '      vite-plus: "catalog:"',
      ].join("\n"),
    );
  });

  it("keeps the patches for installed packages at their vendored paths, and names their files", () => {
    assert.strictEqual(
      blocks.patchedDependencies,
      [
        "patchedDependencies:",
        '  "@effect/vitest@4.0.1": vendor/t3code/patches/@effect__vitest@4.0.1.patch',
        "  # A comment on a patch.",
        '  effect@4.0.1: "vendor/t3code/patches/effect@4.0.1.patch"',
      ].join("\n"),
    );
    assert.deepStrictEqual(patches, [
      "patches/@effect__vitest@4.0.1.patch",
      "patches/effect@4.0.1.patch",
    ]);
  });

  it("leaves out a block with nothing installed", () => {
    const none = pinnedWorkspace(forkWorkspace, new Set(["jose"]));
    assert.strictEqual(none.blocks.overrides, undefined);
    assert.strictEqual(none.blocks.packageExtensions, undefined);
    assert.strictEqual(none.blocks.patchedDependencies, undefined);
    assert.deepStrictEqual(none.patches, []);
  });
});

describe("workspaceDrift", () => {
  const { blocks } = pinnedWorkspace(forkWorkspace, installed);
  const synced = Object.values(blocks).reduce<string>(
    (workspace, block) => `${workspace}\n${block ?? ""}\n`,
    "packages:\n  - extension\n",
  );

  it("is empty for a workspace written from the pin", () => {
    assert.deepStrictEqual(workspaceDrift(synced, blocks), []);
  });

  it("names a block that was removed or edited", () => {
    const removed = replaceBlock(
      replaceBlock(synced, "patchedDependencies", undefined),
      "packageExtensions",
      undefined,
    );
    assert.deepStrictEqual(workspaceDrift(removed, blocks), [
      "changed   pnpm-workspace.yaml packageExtensions",
      "changed   pnpm-workspace.yaml patchedDependencies",
    ]);
    const unpatched = synced.replace("vendor/t3code/patches/effect@4.0.1.patch", "patches/x.patch");
    assert.deepStrictEqual(workspaceDrift(unpatched, blocks), [
      "changed   pnpm-workspace.yaml patchedDependencies",
    ]);
  });
});

// The committed vendored tree against the fork at the pin. It needs the fork's
// checkout, which CI and fresh machines lack; the skipped suite's name says why.
const checkout = t3codeCheckoutPath();
const hasCheckout = NodeFS.existsSync(NodePath.join(checkout, ".git"));

describe.skipIf(!hasCheckout)(
  hasCheckout
    ? "vendored tree"
    : `vendored tree (skipped: no T3 Code Extensible checkout at ${checkout}; set PULT_T3CODE_CHECKOUT)`,
  () => {
    it.effect("matches the fork at the pin", () =>
      Effect.gen(function* () {
        const drift = yield* checkVendored(checkout);
        assert.deepStrictEqual(drift, []);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
