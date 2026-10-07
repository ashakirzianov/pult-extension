import * as vscode from "vscode";

import type { ConnectionPhase, WindowConnection } from "./connection/service.ts";

const ICONS: Record<ConnectionPhase, string> = {
  connecting: "$(sync)",
  ready: "$(plug)",
  reconnecting: "$(sync)",
  offline: "$(debug-disconnect)",
  blocked: "$(error)",
};

/** The bound environment's label and phase; clicking it runs Connect. Hidden in an unbound window. */
export function connectionStatusBar(connection: WindowConnection): vscode.Disposable {
  const item = vscode.window.createStatusBarItem("pult.connection", vscode.StatusBarAlignment.Left);
  item.name = "Pult Connection";
  item.command = "pult.connect";
  const update = () => {
    const environment = connection.environment;
    if (environment === null) {
      item.hide();
      return;
    }
    const { label, phase, error } = environment;
    item.text = `${ICONS[phase]} ${label}${phase === "ready" ? "" : ` (${phase})`}`;
    item.tooltip = `Pult: ${label}, ${phase}${error === null ? "" : `\n${error}`}`;
    item.backgroundColor =
      phase === "blocked"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : phase === "ready" || phase === "connecting"
          ? undefined
          : new vscode.ThemeColor("statusBarItem.warningBackground");
    item.show();
  };
  update();
  return vscode.Disposable.from(item, connection.onDidChange(update));
}
