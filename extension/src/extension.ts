import * as vscode from "vscode";

/** Runs when the Pult view opens or `pult.connect` is invoked, whichever comes first. */
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("pult.connect", () =>
      vscode.window.showInformationMessage("Pult cannot connect to an environment yet."),
    ),
    // The view's welcome content, with its Connect button, shows while the tree is empty.
    vscode.window.registerTreeDataProvider<never>("pult.threads", {
      getChildren: () => [],
      getTreeItem: (element) => element,
    }),
  );
}
