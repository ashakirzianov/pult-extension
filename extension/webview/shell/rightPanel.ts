// Upstream's right panel in Pult's shell: a file the view would open there
// opens as an editor tab of the shell's instead, and the thread details
// panel stays closed. The panel's store is Zustand's, its actions fields of
// the state, so the shell's build replaces them at start and stubs nothing.
// What the panel still holds, diffs, pull requests, devices, terminals,
// stays its own until the shell gives each a place.
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useRightPanelStore } from "../t3/src/rightPanelStore";
import { threadViewHost } from "./host.ts";

/** Once, before any view mounts: files go to the shell, the thread details panel cannot open. */
export function routeRightPanel(): void {
  useRightPanelStore.setState({
    openFile: (ref, path, line) => threadViewHost().openFile(ref.threadId, path, line ?? null),
    setThreadPanelOpen: () => {},
    toggleThreadPanel: () => {},
  });
}

/** The thread's details panel closed, whatever the store remembers of it. */
export function closeThreadPanel(environmentId: string, threadId: string): void {
  const key = scopedThreadKey(scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)));
  useRightPanelStore.setState((state) => ({
    threadPanelVisibilityByThreadKey: {
      ...state.threadPanelVisibilityByThreadKey,
      [key]: { inlineOpen: false, popoverOpen: false },
    },
  }));
}
