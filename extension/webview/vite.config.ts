// The thread bundle, the webview a thread tab loads: `src/main.tsx` mounting
// the tracked copy of the fork's thread view (`t3/`), built the way the fork
// builds its web app (the React Compiler, Tailwind), into dist/webview/. The
// host bundle is esbuild's (package.json); this one is a separate build with no
// `globalThis.location` define, since a webview is a page with a location.
// `--mode shell` builds the same view for Pult's shell instead: `shell/main.tsx`
// as a module the shell's page imports, into dist/shell/, with React, Effect
// and the vendored packages left to the shell's copies.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type BuildEnvironmentOptions, defineConfig, type Plugin } from "vite-plus";
import { esmExternalRequirePlugin } from "vite/rolldown/plugins";

import { SHELL_STUBS, STUBS } from "./stubs.ts";

const webview = import.meta.dirname;
const copy = NodePath.join(webview, "t3");

/** Resolves an import of a stubbed upstream module to its replacement (`stubs.ts`). */
function stubs(map: Readonly<Record<string, string>>): Plugin {
  const replacements = new Map(
    Object.entries(map).map(([upstream, ours]) => [
      NodePath.join(copy, upstream),
      NodePath.join(webview, ours),
    ]),
  );
  return {
    name: "pult:stubs",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (importer === undefined || replacements.has(importer)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const replacement = resolved === null ? undefined : replacements.get(resolved.id);
      return replacement ?? null;
    },
  };
}

/**
 * A webview's document and its resources are different origins, and a worker
 * must be same-origin, so `?worker` imports are built inline as blob workers.
 */
function inlineWorkers(): Plugin {
  return {
    name: "pult:inline-workers",
    enforce: "pre",
    resolveId(source, importer, options) {
      if (!source.endsWith("?worker")) return null;
      return this.resolve(`${source}&inline`, importer, { ...options, skipSelf: true });
    },
  };
}

/**
 * The fork's release at the pin, which its release stamps on `contracts` as on
 * its apps: the view reports it as its own, so upstream's version check
 * compares like with like.
 */
const appVersion: string = JSON.parse(
  NodeFS.readFileSync(
    NodePath.join(webview, "../../vendor/t3code/packages/contracts/package.json"),
    "utf8",
  ),
).version;

// The fork's build-time configuration, all of it off: no T3 Connect, no hosted app.
const env = {
  VITE_WS_URL: "",
  VITE_HTTP_URL: "",
  VITE_T3CODE_RELAY_URL: "",
  VITE_CLERK_PUBLISHABLE_KEY: "",
  VITE_CLERK_JWT_TEMPLATE: "",
  VITE_CLERK_CLI_OAUTH_CLIENT_ID: "",
  VITE_RELAY_OTLP_TRACES_URL: "",
  VITE_RELAY_OTLP_TRACES_DATASET: "",
  VITE_RELAY_OTLP_TRACES_TOKEN: "",
  VITE_HOSTED_APP_URL: "",
  VITE_HOSTED_APP_CHANNEL: "",
  APP_VERSION: appVersion,
};

/** The packages the shell's page holds one copy of, which its build imports rather than bundles. */
const SHELL_EXTERNAL =
  /^(react|react-dom|effect|@t3tools\/(client-runtime|contracts|shared))($|\/)/;

const webviewBuild: BuildEnvironmentOptions = {
  outDir: NodePath.join(webview, "../dist/webview"),
  emptyOutDir: true,
  cssCodeSplit: false,
  rollupOptions: {
    input: NodePath.join(webview, "src/main.tsx"),
    output: {
      entryFileNames: "thread.js",
      chunkFileNames: "chunks/[name]-[hash].js",
      assetFileNames: (asset) =>
        asset.names.some((name) => name.endsWith(".css"))
          ? "thread.css"
          : "assets/[name]-[hash][extname]",
    },
  },
};

const shellBuild: BuildEnvironmentOptions = {
  outDir: NodePath.join(webview, "../dist/shell"),
  emptyOutDir: true,
  cssCodeSplit: false,
  lib: {
    entry: NodePath.join(webview, "shell/main.tsx"),
    formats: ["es"],
    fileName: () => "thread.js",
  },
  rollupOptions: {
    // The bundled CommonJS packages `require` React, which an ES module
    // cannot: their requires of the externals become imports.
    plugins: [esmExternalRequirePlugin({ external: [SHELL_EXTERNAL] })],
    output: {
      chunkFileNames: "chunks/[name]-[hash].js",
      assetFileNames: (asset) =>
        asset.names.some((name) => name.endsWith(".css"))
          ? "thread.css"
          : "assets/[name]-[hash][extname]",
    },
  },
};

export default defineConfig(({ mode }) => ({
  root: webview,
  // Assets resolve against the bundle's own URL, which `asWebviewUri` gives.
  base: "./",
  assetsInclude: ["**/*.wasm"],
  plugins: [
    stubs(mode === "shell" ? SHELL_STUBS : STUBS),
    inlineWorkers(),
    react({ compiler: true }),
    tailwindcss(),
  ],
  define: Object.fromEntries(
    Object.entries(env).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
  ),
  resolve: {
    alias: { "~": NodePath.join(copy, "src") },
    dedupe: ["react", "react-dom"],
  },
  build: mode === "shell" ? shellBuild : webviewBuild,
  // Upstream's: the file viewers start module workers.
  worker: { format: "es" },
}));
