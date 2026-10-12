// The thread commands on a thread tab, its title bar and its context menu, and
// in the palette, offer what the picker's row offers for the thread's shelf:
// Pin or Unpin, Snooze or Wake, Settle or Un-settle, never both. A menu's when
// clause sees the tab's URI as `resource`, so the host keeps the open thread
// tabs' URIs by shelf as context keys (`resource in pult.threadTabs.pinned`),
// and the active tab's shelf for the palette (`pult.activeTabShelf`).
import * as vscode from "vscode";

import type { ThreadsModel } from "./model.ts";
import { tabMenuContext } from "./presentation.ts";
import { THREAD_VIEW_TYPE } from "./uri.ts";

/** Keeps the menus' context keys (`tabMenuContext`) as tabs, threads and features change. */
export function threadTabMenus(model: ThreadsModel): vscode.Disposable {
  let last = "";
  const update = () => {
    const threadTab = (tab: vscode.Tab | undefined) =>
      tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === THREAD_VIEW_TYPE
        ? tab.input.uri
        : undefined;
    const context = tabMenuContext({
      tabs: vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map(threadTab)
        .filter((uri) => uri !== undefined),
      active: threadTab(vscode.window.tabGroups.activeTabGroup.activeTab),
      environmentId: model.environmentId,
      thread: (threadId) => model.thread(threadId),
      now: new Date().toISOString(),
      features: model.features,
    });
    const serialized = JSON.stringify(context);
    if (serialized === last) return;
    last = serialized;
    for (const [shelf, uris] of Object.entries(context.tabs)) {
      void vscode.commands.executeCommand("setContext", `pult.threadTabs.${shelf}`, uris);
    }
    void vscode.commands.executeCommand("setContext", "pult.activeTabShelf", context.activeShelf);
  };
  update();
  return vscode.Disposable.from(
    model.onDidChange(update),
    vscode.window.tabGroups.onDidChangeTabs(update),
    vscode.window.tabGroups.onDidChangeTabGroups(update),
  );
}
