import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkVendored, extractCatalogBlock, parsePin, replaceCatalogBlock } from "./vendor.ts";
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

describe("catalog rewrite", () => {
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
  const fork = [
    "packages:",
    "  - apps/*",
    "  - examples/plugins/*",
    "catalog:",
    "  effect: 4.0.1",
    "  jose: 6.2.2",
    "minimumReleaseAgeExclude:",
    "  - effect@4.0.1",
  ].join("\n");

  it("takes the whole block, through blank lines, up to the next top-level line", () => {
    assert.strictEqual(
      extractCatalogBlock(ours),
      'catalog:\n  "@types/node": 24.12.4\n  effect: 4.0.0\n\n  # kept apart\n  vite-plus: 1.0.0',
    );
  });

  it("replaces only the catalog block, keeping everything around it", () => {
    assert.strictEqual(
      replaceCatalogBlock(ours, fork),
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

  it("is a no-op when the catalogs already match", () => {
    assert.strictEqual(replaceCatalogBlock(ours, ours), ours);
  });

  it("refuses a file without a catalog block", () => {
    assert.strictEqual(replaceCatalogBlock("packages:\n  - apps/*\n", fork), undefined);
    assert.strictEqual(replaceCatalogBlock(ours, "packages:\n  - apps/*\n"), undefined);
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
