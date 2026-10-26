// Upstream's right panel in Pult's shell: a file the view would open there
// opens as an editor tab of the shell's instead, its diff surface is the
// shell's changes view, and the thread details panel stays closed. The
// panel's store is Zustand's, its actions fields of the state, so the
// shell's build replaces them at start and stubs nothing. What the panel
// still holds, pull requests, devices, terminals, stays its own until the
// shell gives each a place.
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../t3/src/diffPanelStore";
import { useRightPanelStore } from "../t3/src/rightPanelStore";
import { threadViewHost } from "./host.ts";

/**
 * Once, before any view mounts: files and the diff go to the shell, a
 * turn's completion opens no panel, the thread details panel cannot open.
 */
export function routeRightPanel(): void {
  const { open, openProactive } = useRightPanelStore.getState();
  useRightPanelStore.setState({
    openFile: (ref, path, line) => threadViewHost().openFile(ref.threadId, path, line ?? null),
    open: (ref, kind) => {
      if (kind !== "diff") return open(ref, kind);
      // The view selects the turn and its file in the diff store before opening the surface.
      const selection = selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref);
      threadViewHost().openChanges(ref.threadId, selection.kind === "turn" ? selection.filePath : null);
    },
    openProactive: (ref, surface, revision) =>
      surface.kind === "diff" ? false : openProactive(ref, surface, revision),
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
