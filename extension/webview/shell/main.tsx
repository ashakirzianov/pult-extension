// The shell's thread view: upstream's turns and composer as a module Pult's
// shell imports into its page (the `pult` repo's `src/threads/pane.tsx`),
// built by `../vite.config.ts` in its `shell` mode into dist/shell/. React,
// Effect and the vendored packages stay imports, which the shell resolves to
// its own copies, so the page holds one client runtime; the rest of the view
// is bundled here, as for the thread tabs' webview.
import "../t3/src/index.css";
import "./shell.css";

import vendoredCommit from "../../../vendor/t3code/COMMIT?raw";

import { followColorScheme } from "../src/theme.ts";
import { setThreadViewHost, type ThreadViewHost } from "./host.ts";
import { routeRightPanel } from "./rightPanel.ts";
import { mountThreadView } from "./ThreadView.tsx";

export type { ThreadViewHost } from "./host.ts";
export type { ShellConnectionServices } from "./connectionRuntime.ts";

/**
 * The T3 Code commit this view is built against. The view imports the shell's
 * vendored packages, so the shell refuses a view whose commit is not its own.
 */
export const VENDORED_COMMIT = vendoredCommit.trim();

/**
 * Starts the view on the shell's connection; call once, before any pane
 * mounts. The view follows the workbench's theme, as a thread tab follows
 * VS Code's (`../src/theme.ts`), and its files open in the shell
 * (`rightPanel.ts`).
 */
export function startThreadView(host: ThreadViewHost, workbench: Element) {
  setThreadViewHost(host);
  routeRightPanel();
  followColorScheme(workbench, () =>
    ["vs-dark", "hc-black"].some((name) => workbench.classList.contains(name)),
  );
  return { mount: mountThreadView };
}
