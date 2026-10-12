import type { ThreadTarget, WebviewEnvironment } from "../../src/threads/protocol.ts";

export interface Session {
  readonly environment: WebviewEnvironment;
  /** The thread the tab opened on; the view may since have moved from a draft to its thread. */
  readonly target: ThreadTarget;
  readonly development: boolean;
}

let current: Session | undefined;

/** Set once, from the host's `init`, before the thread view's modules load. */
export function startSession(session: Session): void {
  current = session;
}

export function session(): Session {
  if (current === undefined) throw new Error("The thread view loaded before the host's init.");
  return current;
}
