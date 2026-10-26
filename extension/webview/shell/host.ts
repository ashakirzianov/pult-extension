import type * as Context from "effect/Context";

import type { ShellConnectionServices } from "./connectionRuntime.ts";

/**
 * What Pult's shell hands its in-process thread view (`main.tsx`): the
 * services of the page's connection runtime, which the view's state runtime
 * runs on, the environment the page is connected to, where a thread the
 * view navigates to opens, and where a file the view would show in its
 * right panel opens instead (`rightPanel.ts`): a path relative to the
 * thread's project root, or an absolute host path, and a line to reveal.
 * The shell's side is its `src/threads/pane.tsx`.
 */
export interface ThreadViewHost {
  readonly connection: () => Promise<Context.Context<ShellConnectionServices>>;
  readonly environmentId: () => string | null;
  readonly openThread: (threadId: string) => void;
  readonly openFile: (threadId: string, path: string, line: number | null) => void;
}

let current: ThreadViewHost | undefined;

/** Set once, by `startThreadView`, before any view mounts. */
export function setThreadViewHost(host: ThreadViewHost): void {
  current = host;
}

export function threadViewHost(): ThreadViewHost {
  if (current === undefined)
    throw new Error("The thread view mounted before the shell started it.");
  return current;
}
