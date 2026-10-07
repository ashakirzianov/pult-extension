import * as vscode from "vscode";

import { registerCommands } from "./commands.ts";
import { EnvironmentCatalog, WindowBinding } from "./connection/catalog.ts";
import type { BoundEnvironment } from "./connection/presentation.ts";
import { WindowConnection } from "./connection/service.ts";
import { connectionStatusBar } from "./statusBar.ts";
import { threadsView } from "./threadsView.ts";

/**
 * What `activate` returns outside production, for the headless load to watch
 * the connection: the bound environment without its credential. An installed
 * Pult exports nothing, since every extension can read another's exports.
 */
export interface PultTestApi {
  readonly environment: Omit<BoundEnvironment, "prepared"> | null;
  readonly onDidChange: vscode.Event<void>;
}

/**
 * Runs once startup finishes, so a bound window reconnects silently, or earlier
 * when the Pult view opens or a Pult command runs.
 */
export async function activate(context: vscode.ExtensionContext): Promise<PultTestApi | undefined> {
  const development = context.extensionMode !== vscode.ExtensionMode.Production;
  const catalog = new EnvironmentCatalog(context.globalState, context.secrets);
  const binding = new WindowBinding(context.workspaceState);
  const bound = binding.environmentId;
  // Forgotten in another window while this one was closed.
  if (bound !== undefined && catalog.profile(bound) === undefined) await binding.unbind();

  const connection = new WindowConnection(catalog, binding);
  const updateContext = () =>
    vscode.commands.executeCommand("setContext", "pult.bound", connection.environment !== null);
  void updateContext();
  context.subscriptions.push(
    connection,
    connectionStatusBar(connection),
    threadsView(connection),
    ...registerCommands(catalog, connection, development),
    connection.onDidChange(updateContext),
    // Another window forgot the bound environment, or paired it again.
    context.secrets.onDidChange(async ({ key }) => {
      const environmentId = catalog.credentialEnvironment(key);
      if (environmentId === undefined || environmentId !== binding.environmentId) return;
      if ((await catalog.credential(environmentId)) === undefined) {
        const label = connection.environment?.label ?? environmentId;
        await connection.disconnect();
        void vscode.window.showInformationMessage(`Pult disconnected: ${label} was forgotten.`);
      } else if (connection.environment?.phase === "blocked") {
        await connection.retryNow();
      }
    }),
  );
  return development ? testApi(connection) : undefined;
}

function testApi(connection: WindowConnection): PultTestApi {
  return {
    get environment() {
      if (connection.environment === null) return null;
      const { prepared: _credential, ...environment } = connection.environment;
      return environment;
    },
    onDidChange: connection.onDidChange,
  };
}
