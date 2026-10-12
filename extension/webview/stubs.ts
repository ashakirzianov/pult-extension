// The upstream modules the thread bundle replaces with files of ours, keyed by
// their path in the copy (`t3/`), valued by the replacement's path in this
// directory. The bundler resolves every import of a key to its value
// (`vite.config.ts`); the copy keeps the upstream module, so the code that
// imports it still typechecks and `pnpm vendor:merge` still merges it, and the
// replacement states which upstream module it stands in for. A stub is how the
// thread view reaches what the app around it would provide; editing a copied
// file is the exception (`t3/EDITS.md`).
export const STUBS: Readonly<Record<string, string>> = {
  // The composition root of the vendored runtime: the platform of a webview
  // whose socket and HTTP go through the extension host.
  "src/connection/runtime.ts": "src/connectionRuntime.ts",
  // The device panel's 3D phone models, 12 MB of assets: the panel shows the
  // flat stream without them.
  "src/components/device/deviceModels.ts": "src/stubs/deviceModels.ts",
};
