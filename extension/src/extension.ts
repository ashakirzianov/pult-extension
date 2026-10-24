import * as vscode from "vscode";

import { registerCommands } from "./commands.ts";
import { shellBridge } from "./shellBridge.ts";
import { EnvironmentCatalog, WindowBinding } from "./connection/catalog.ts";
import type { BoundEnvironment } from "./connection/presentation.ts";
import { WindowConnection } from "./connection/service.ts";
import {
  followShell,
  IN_PULT_SHELL,
  memoryCatalogStorage,
  ShellConnectionClient,
} from "./connection/shell.ts";
import { connectionStatusBar } from "./statusBar.ts";
import { registerThreads } from "./threads/index.ts";
import { threadStatus } from "./threads/presentation.ts";
import { SocketHub } from "./threads/socketHub.ts";
import { bindToFolders, foldersEnvironment, virtualWorkspace } from "./workspace/index.ts";

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
  // In Pult the page owns the connection (`connection/shell.ts`): the catalog
  // holds only the shell's environment, and the window connection runs over
  // the shell's socket and fetch.
  const shell = IN_PULT_SHELL ? await ShellConnectionClient.start() : undefined;
  const storage = shell === undefined ? context : memoryCatalogStorage();
  const catalog = new EnvironmentCatalog(storage.globalState, storage.secrets);
  if (shell?.environment != null) {
    const { profile, credential } = shell.registration(shell.environment);
    await catalog.saveProfile(profile);
    await catalog.saveCredential(profile.environmentId, credential.token);
  }
  const binding = new WindowBinding(context.workspaceState);
  const bound = binding.environmentId;
  // Forgotten in another window while this one was closed.
  if (bound !== undefined && catalog.profile(bound) === undefined) await binding.unbind();
  // The virtual workspace: an unbound window binds to the environment its `pult:` folders name.
  const unpaired = await bindToFolders(catalog, binding);

  const hub = new SocketHub(shell?.webSocketConstructor);
  const connection = new WindowConnection(catalog, binding, hub, shell?.fetch);
  let stock = false;
  // Before the connection, so the folders' watches stop before it does. In
  // Pult the shell pairs, so unpaired folders offer nothing.
  context.subscriptions.push(
    ...virtualWorkspace(
      connection,
      binding,
      shell === undefined ? unpaired : undefined,
      () => stock,
    ),
  );
  // The threads: the picker, the tabs, their decorations and commands; before
  // the connection too, so the tabs let go of the socket before it closes.
  const threads = registerThreads({ context, development, catalog, connection, hub });
  context.subscriptions.push(...threads.disposables);
  // The spike's in-process channel to Pult's own shell; inert elsewhere.
  context.subscriptions.push(shellBridge(connection, threads.model));
  const updateContext = () =>
    vscode.commands.executeCommand("setContext", "pult.bound", connection.environment !== null);
  void updateContext();
  if (shell !== undefined) {
    context.subscriptions.push(followShell(shell, connection, binding.environmentId));
  }
  context.subscriptions.push(
    connection,
    hub,
    connectionStatusBar(connection),
    ...registerCommands(catalog, connection, development, foldersEnvironment),
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
  // Disposed after the connection, so its socket closes before the shell's bridge does.
  if (shell !== undefined) context.subscriptions.push(shell);
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
          working: threadStatus(thread, new Date().toISOString())?.badge === "R",
        })),
      onDidChange: threads.model.onDidChange,
      probe: (uri) => threads.editor.probe(uri),
      send: (uri, text) => threads.editor.send(uri, text),
    },
  };
}
