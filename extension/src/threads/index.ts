import * as vscode from "vscode";

import type { EnvironmentCatalog } from "../connection/catalog.ts";
import type { WindowConnection } from "../connection/service.ts";
import { registerThreadCommands } from "./commands.ts";
import { threadDecorations } from "./decorations.ts";
import { ThreadEditorProvider } from "./editor.ts";
import { ProjectFavicons } from "./favicons.ts";
import { ThreadsModel } from "./model.ts";
import { threadPicker } from "./picker.ts";
import type { SocketHub } from "./socketHub.ts";
import { THREAD_VIEW_TYPE } from "./uri.ts";

/** The threads of the window's environment: the picker, a tab per thread, their status, their commands. */
export function registerThreads(input: {
  readonly context: vscode.ExtensionContext;
  readonly development: boolean;
  readonly catalog: EnvironmentCatalog;
  readonly connection: WindowConnection;
  readonly hub: SocketHub;
}) {
  const { context, development, catalog, connection, hub } = input;
  const model = new ThreadsModel(connection);
  const favicons = new ProjectFavicons(connection);
  const editor = new ThreadEditorProvider({
    development,
    extensionUri: context.extensionUri,
    catalog,
    connection,
    hub,
    model,
    workspaceState: context.workspaceState,
  });
  return {
    editor,
    model,
    disposables: [
      model,
      favicons,
      editor,
      vscode.window.registerCustomEditorProvider(THREAD_VIEW_TYPE, editor, {
        supportsMultipleEditorsPerDocument: true,
      }),
      threadPicker({ connection, model, favicons, workspaceState: context.workspaceState }),
      threadDecorations(model),
      ...registerThreadCommands(connection, model),
    ],
  };
}
