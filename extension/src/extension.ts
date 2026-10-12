import * as vscode from "vscode";

import { registerCommands } from "./commands.ts";
import { EnvironmentCatalog, WindowBinding } from "./connection/catalog.ts";
import type { BoundEnvironment } from "./connection/presentation.ts";
import { WindowConnection } from "./connection/service.ts";
import { connectionStatusBar } from "./statusBar.ts";
import { registerThreads } from "./threads/index.ts";
import { threadStatus } from "./threads/presentation.ts";
import { SocketHub } from "./threads/socketHub.ts";
import { bindToFolders, virtualWorkspace } from "./workspace/index.ts";

/**
 * What `activate` returns outside production, for the headless load to watch
 * the connection: the bound environment without its credential. An installed
 * Pult exports nothing, since every extension can read another's exports.
 */
export interface PultTestApi {
  readonly environment: Omit<BoundEnvironment, "prepared"> | null;
  readonly onDidChange: vscode.Event<void>;
  /** From now on the workspace treats the server as stock, using none of the fork's features. */
  readonly simulateStockServer: () => void;
  readonly threads: {
    readonly list: () => ReadonlyArray<TestThread>;
    readonly onDidChange: vscode.Event<void>;
    /** A thread tab's page text. */
    readonly probe: (uri: string) => Promise<string>;
    /** Sends a message through a thread tab's composer. */
    readonly send: (uri: string, text: string) => Promise<void>;
  };
}

export interface TestThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly pinned: boolean;
  readonly settled: boolean;
  readonly snoozed: boolean;
  /** Its agent is running, queued, or held by background work. */
  readonly working: boolean;
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
  // The virtual workspace: an unbound window binds to the environment its `pult:` folders name.
  const unpaired = await bindToFolders(catalog, binding);

  const hub = new SocketHub();
  const connection = new WindowConnection(catalog, binding, hub);
  let stock = false;
  // Before the connection, so the folders' watches stop before it does.
  context.subscriptions.push(...virtualWorkspace(connection, binding, unpaired, () => stock));
  // The threads: the picker, the tabs, their decorations and commands; before
  // the connection too, so the tabs let go of the socket before it closes.
  const threads = registerThreads({ context, development, catalog, connection, hub });
  context.subscriptions.push(...threads.disposables);
  const updateContext = () =>
    vscode.commands.executeCommand("setContext", "pult.bound", connection.environment !== null);
  void updateContext();
  context.subscriptions.push(
    connection,
    hub,
    connectionStatusBar(connection),
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
  return development
    ? testApi(connection, threads, () => {
        stock = true;
      })
    : undefined;
}

function testApi(
  connection: WindowConnection,
  threads: ReturnType<typeof registerThreads>,
  simulateStockServer: () => void,
): PultTestApi {
  return {
    simulateStockServer,
    get environment() {
      if (connection.environment === null) return null;
      const { prepared: _credential, ...environment } = connection.environment;
      return environment;
    },
    onDidChange: connection.onDidChange,
    threads: {
      list: () =>
        threads.model.threads().map((thread) => ({
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          pinned: thread.pinnedAt !== null,
          settled: thread.settledOverride === "settled",
          snoozed: thread.snoozedUntil !== null,
          working: ["R", "Q"].includes(threadStatus(thread)?.badge ?? ""),
        })),
      onDidChange: threads.model.onDidChange,
      probe: (uri) => threads.editor.probe(uri),
      send: (uri, text) => threads.editor.send(uri, text),
    },
  };
}
