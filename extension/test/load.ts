// The headless load, `pnpm test:web`: @vscode/test-web runs this in VS Code for the
// Web's web worker extension host, beside the extension, and fails the run on a throw.
import * as vscode from "vscode";

export async function run() {
  const extension = vscode.extensions.getExtension("pult.pult");
  if (extension === undefined) throw new Error("pult.pult is not installed.");
  await vscode.commands.executeCommand("workbench.view.extension.pult");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of ["pult.connect", "pult.threads.focus"]) {
    if (!commands.includes(command)) throw new Error(`${command} is not registered.`);
  }
  console.log(`${extension.id} activated in VS Code ${vscode.version} for the Web.`);
}
