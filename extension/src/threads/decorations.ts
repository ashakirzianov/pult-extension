import * as vscode from "vscode";

import type { ThreadsModel } from "./model.ts";
import { type StatusBadge, threadStatus } from "./presentation.ts";
import { parseThreadUri } from "./uri.ts";

const COLORS: Record<StatusBadge, string> = {
  R: "pult.threadRunning",
  W: "pult.threadWaiting",
  F: "pult.threadFailed",
};

/**
 * A thread's status as a badge, the git panel's way: on its row in the
 * picker and on its tab, both keyed by the thread id in a `pult-thread:` URI.
 */
export function threadDecorations(model: ThreadsModel): vscode.Disposable {
  const changes = new vscode.EventEmitter<undefined>();
  const provider: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: changes.event,
    provideFileDecoration: (uri) => {
      const resource = parseThreadUri(uri);
      if (resource === null || resource.target.kind !== "thread") return undefined;
      if (resource.environmentId !== model.environmentId) return undefined;
      const thread = model.thread(resource.target.threadId);
      const status = thread === undefined ? null : threadStatus(thread, new Date().toISOString());
      if (status?.badge == null) return undefined;
      return new vscode.FileDecoration(
        status.badge,
        status.label,
        new vscode.ThemeColor(COLORS[status.badge]),
      );
    },
  };
  return vscode.Disposable.from(
    changes,
    vscode.window.registerFileDecorationProvider(provider),
    model.onDidChange(() => changes.fire(undefined)),
  );
}
