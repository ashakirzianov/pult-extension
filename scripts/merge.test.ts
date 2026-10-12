import { describe, expect, it } from "vite-plus/test";

import { closure, importSpecifiers, isCode, resolveSpecifier } from "./merge.ts";

describe("importSpecifiers", () => {
  it("names every import, type-only and dynamic ones too", () => {
    const source = [
      'import React from "react";',
      'import type { A } from "./a";',
      "import {",
      "  b,",
      "  type C,",
      '} from "../b";',
      'export * from "./c";',
      'export { d } from "~/d";',
      'import "./side.css";',
      'const lazy = import("./lazy");',
      'const wasm = new URL("./x.wasm", import.meta.url);',
      'import model from "./m.glb?url";',
      'const text = "not an import from \\"./nowhere\\"";',
    ].join("\n");
    expect(importSpecifiers(source, "f.ts")).toEqual(
      expect.arrayContaining([
        "react",
        "./a",
        "../b",
        "./c",
        "~/d",
        "./side.css",
        "./lazy",
        "./x.wasm",
        "./m.glb",
      ]),
    );
  });

  it("reads a stylesheet's imports and local URLs, not data or remote ones", () => {
    const css =
      '@import "tailwindcss";\n@import "./theme.css";\n.a { background: url(./grain.png); }\n.b { mask: url("data:image/svg+xml,x"); }\n.c { src: url(https://x/y.woff2); }';
    expect(importSpecifiers(css, "f.css")).toEqual(["tailwindcss", "./theme.css", "./grain.png"]);
  });
});

describe("resolveSpecifier", () => {
  const files = new Set([
    "extension/webview/t3/src/a.ts",
    "extension/webview/t3/src/ui/index.tsx",
    "extension/webview/t3/src/b.logic.ts",
    "extension/webview/t3/src/style.css",
  ]);
  const exists = (file: string) => files.has(file);

  it("resolves relative and `~/` imports by the bundler's suffixes", () => {
    expect(resolveSpecifier("extension/webview/t3/src/x/y.ts", "../a", exists)).toBe(
      "extension/webview/t3/src/a.ts",
    );
    expect(resolveSpecifier("extension/webview/src/main.tsx", "../t3/src/ui", exists)).toBe(
      "extension/webview/t3/src/ui/index.tsx",
    );
    expect(resolveSpecifier("extension/webview/t3/src/a.ts", "~/b.logic", exists)).toBe(
      "extension/webview/t3/src/b.logic.ts",
    );
    expect(resolveSpecifier("extension/webview/t3/src/a.ts", "./style.css", exists)).toBe(
      "extension/webview/t3/src/style.css",
    );
  });

  it("leaves packages and missing files unresolved", () => {
    expect(resolveSpecifier("extension/webview/t3/src/a.ts", "react", exists)).toBeNull();
    expect(resolveSpecifier("extension/webview/t3/src/a.ts", "./gone", exists)).toBeNull();
  });
});

describe("closure", () => {
  const sources: Record<string, string> = {
    "extension/webview/src/main.tsx": 'import "../t3/src/view";',
    "extension/webview/src/runtime.ts": 'import type { R } from "../t3/src/runtime";',
    "extension/webview/t3/src/view.tsx":
      'import { runtime } from "./runtime";\nimport font from "./font.woff2?url";',
    "extension/webview/t3/src/runtime.ts":
      'import model from "./model.glb?url";\nimport { helper } from "./helper";\nimport "./missing";',
    "extension/webview/t3/src/helper.ts": "export const helper = 1;",
    "extension/webview/t3/src/font.woff2": "",
    "extension/webview/t3/src/model.glb": "",
  };
  const reached = closure({
    roots: ["extension/webview/src/main.tsx", "extension/webview/src/runtime.ts"],
    read: (file) => sources[file]!,
    exists: (file) => file in sources,
    stubs: new Set(["src/runtime.ts"]),
  });

  it("takes source through a stub, which tsc reads, but no asset past it", () => {
    expect([...reached.files].toSorted()).toEqual([
      "src/font.woff2",
      "src/helper.ts",
      "src/runtime.ts",
      "src/view.tsx",
    ]);
  });

  it("reports imports that name no file", () => {
    expect(reached.unresolved).toEqual(["extension/webview/t3/src/runtime.ts: ./missing"]);
  });

  it("tells source from assets", () => {
    expect(isCode("src/a.tsx")).toBe(true);
    expect(isCode("src/index.css")).toBe(true);
    expect(isCode("src/x.wasm")).toBe(false);
  });
});
