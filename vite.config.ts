import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    // The vendored packages' own tests are the fork's to run.
    include: [
      "extension/src/**/*.test.ts",
      "extension/webview/src/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
  },
  fmt: {
    ignorePatterns: [
      // The fork's files, kept byte for byte (scripts/vendor.ts), and the copy
      // that merges upstream's changes (scripts/merge.ts) in upstream's format.
      "vendor/t3code/packages/**",
      "vendor/t3code/patches/**",
      "extension/webview/t3/**",
      "dist",
      "release",
      "node_modules",
      "pnpm-lock.yaml",
    ],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: [
      "vendor/t3code/packages/**",
      "extension/webview/t3/**",
      "dist",
      "release",
      "node_modules",
    ],
    plugins: ["eslint", "oxc", "unicorn", "typescript"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      // Pult's settings for Effect code: tagged unions, generator loops and scoped helpers.
      "unicorn/consistent-function-scoping": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@t3tools/client-runtime",
              message:
                "Import from an explicit @t3tools/client-runtime/* subpath. The package has no root export.",
            },
          ],
        },
      ],
    },
  },
});
