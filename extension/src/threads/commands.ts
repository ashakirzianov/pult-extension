import type { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  pinThread,
  settleThread,
  snoozeThread,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
} from "@t3tools/client-runtime/operations";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  resolveCustomSnooze,
  resolveSnoozePresets,
} from "@t3tools/client-runtime/state/thread-settled";
import { ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as vscode from "vscode";

import type { WindowConnection } from "../connection/service.ts";
import { openThreadTab } from "./editor.ts";
import type { ThreadsModel } from "./model.ts";
import type { ThreadFeatures } from "./presentation.ts";
import { threadFromArgument } from "./picker.ts";
import { parseThreadUri, THREAD_VIEW_TYPE } from "./uri.ts";

const FEATURE_NAMES: Record<keyof ThreadFeatures, string> = {
  settlement: "settling threads",
  snooze: "snoozing threads",
  pinning: "pinning threads",
};

// The thread commands mint their command ids with it.
const webCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(async () => {
      const input = new Uint8Array(data.length);
      input.set(data);
      return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
    }),
});

/**
 * The thread commands: from a picker row, a thread tab's menus (which pass its
 * URI), or the palette, where they act on the active thread tab.
 */
export function registerThreadCommands(connection: WindowConnection, model: ThreadsModel) {
  const run = <A, E>(
    effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor | Crypto.Crypto>,
  ) => connection.run(effect.pipe(Effect.provideService(Crypto.Crypto, webCrypto)));
  // A picker row passes the row and the selection; a tab menu, the tab's URI;
  // the palette, nothing, for the active tab.
  const thread = (argument: unknown) =>
    argument === undefined ? activeThread(model) : threadFromArgument(model, argument);
  const withThread =
    (
      action: (
        thread: EnvironmentThreadShell,
        option: unknown,
      ) => Promise<unknown> | Thenable<unknown>,
    ) =>
    async (argument: unknown, option?: unknown) => {
      const target = thread(argument);
      if (target === undefined) {
        void vscode.window.showInformationMessage("Pult: open or select a thread first.");
        return;
      }
      try {
        await action(target, option);
      } catch (error) {
        console.error(error);
        void vscode.window.showErrorMessage(`Pult: ${errorMessage(error)}`);
      }
    };
  // A server that does not advertise a feature never gets its commands
  // (`pult/decisions`, `capability-gated-rpcs`); their menus hide on the context keys.
  const gated =
    (
      feature: keyof ThreadFeatures,
      action: (thread: EnvironmentThreadShell, option: unknown) => Promise<unknown>,
    ) =>
    (thread: EnvironmentThreadShell, option: unknown) => {
      if (!model.features[feature]) {
        throw new Error(`this environment's server does not support ${FEATURE_NAMES[feature]}.`);
      }
      return action(thread, option);
    };
  const command = (input: { readonly threadId: string }) => ({
    threadId: ThreadId.make(input.threadId),
  });
  const open = (target: EnvironmentThreadShell, options: vscode.TextDocumentShowOptions = {}) =>
    openThreadTab(
      { kind: "thread", threadId: target.id },
      target.environmentId,
      target.title,
      options,
    );

  return [
    vscode.commands.registerCommand(
      "pult.openThread",
      withThread((target) => open(target)),
    ),
    vscode.commands.registerCommand(
      "pult.openThreadToSide",
      withThread((target) => open(target, { viewColumn: vscode.ViewColumn.Beside })),
    ),
    vscode.commands.registerCommand("pult.newThread", (projectId?: unknown) =>
      newThread(model, typeof projectId === "string" ? projectId : undefined),
    ),
    vscode.commands.registerCommand(
      "pult.newThreadInProject",
      withThread((target) => newThread(model, target.projectId)),
    ),
    vscode.commands.registerCommand(
      "pult.settleThread",
      withThread(
        gated("settlement", (target) => run(settleThread(command({ threadId: target.id })))),
      ),
    ),
    vscode.commands.registerCommand(
      "pult.unsettleThread",
      withThread(
        gated("settlement", (target) =>
          run(unsettleThread({ ...command({ threadId: target.id }), reason: "user" })),
        ),
      ),
    ),
    vscode.commands.registerCommand(
      "pult.snoozeThread",
      // A wake time as the second argument skips the pick, for the headless load.
      withThread(
        gated("snooze", async (target, wake) => {
          const snoozedUntil = typeof wake === "string" ? wake : await pickSnooze();
          if (snoozedUntil === undefined) return;
          await run(snoozeThread({ ...command({ threadId: target.id }), snoozedUntil }));
        }),
      ),
    ),
    vscode.commands.registerCommand(
      "pult.unsnoozeThread",
      withThread(
        gated("snooze", (target) =>
          run(unsnoozeThread({ ...command({ threadId: target.id }), reason: "user" })),
        ),
      ),
    ),
    vscode.commands.registerCommand(
      "pult.pinThread",
      withThread(gated("pinning", (target) => run(pinThread(command({ threadId: target.id }))))),
    ),
    vscode.commands.registerCommand(
      "pult.unpinThread",
      withThread(gated("pinning", (target) => run(unpinThread(command({ threadId: target.id }))))),
    ),
    vscode.commands.registerCommand(
      "pult.copyThreadLink",
      withThread(async (target) => {
        const prepared = Option.getOrUndefined(connection.environment?.prepared ?? Option.none());
        if (prepared === undefined) throw new Error("the environment is not connected.");
        // The thread in the environment's own web app, where any browser can follow it.
        const link = new URL(`/${target.environmentId}/${target.id}`, prepared.httpBaseUrl);
        await vscode.env.clipboard.writeText(link.toString());
        void vscode.window.setStatusBarMessage(`Copied the link to ${target.title}.`, 3_000);
      }),
    ),
  ];
}

function activeThread(model: ThreadsModel): EnvironmentThreadShell | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof vscode.TabInputCustom) || input.viewType !== THREAD_VIEW_TYPE) {
    return undefined;
  }
  const resource = parseThreadUri(input.uri);
  return resource?.target.kind === "thread" && resource.environmentId === model.environmentId
    ? model.thread(resource.target.threadId)
    : undefined;
}

/** Opens a draft tab in a project: the one given, or one the user picks, the active thread's first. */
async function newThread(model: ThreadsModel, projectId: string | undefined) {
  const environmentId = model.environmentId;
  if (environmentId === null) {
    void vscode.window.showInformationMessage("Pult is not connected to an environment.");
    return;
  }
  let chosen = projectId;
  if (chosen === undefined) {
    const current = activeThread(model)?.projectId;
    const projects = model
      .projects()
      .toSorted(
        (left, right) =>
          Number(right.id === current) - Number(left.id === current) ||
          left.title.localeCompare(right.title),
      );
    if (projects.length === 0) {
      void vscode.window.showInformationMessage("This environment has no projects.");
      return;
    }
    chosen =
      projects.length === 1
        ? projects[0]!.id
        : (
            await vscode.window.showQuickPick(
              projects.map((project) => ({
                label: project.title,
                description: project.workspaceRoot,
                projectId: project.id,
              })),
              { placeHolder: "New thread in project" },
            )
          )?.projectId;
  }
  if (chosen === undefined) return;
  await openThreadTab(
    { kind: "draft", draftId: crypto.randomUUID(), projectId: chosen },
    environmentId,
    "",
  );
}

/** Upstream's snooze presets, and a custom wake as a duration or a local time. */
async function pickSnooze(): Promise<string | undefined> {
  const now = new Date();
  const custom = { label: "$(edit) Custom…", snoozedUntil: undefined };
  const picked = await vscode.window.showQuickPick(
    [
      ...resolveSnoozePresets(now).map((preset) => ({
        label: preset.label,
        description: preset.whenLabel,
        snoozedUntil: preset.snoozedUntil,
      })),
      custom,
    ],
    { placeHolder: "Snooze until" },
  );
  if (picked === undefined || picked.snoozedUntil !== undefined) return picked?.snoozedUntil;
  const text = await vscode.window.showInputBox({
    title: "Snooze until",
    prompt: "A duration such as 45m, 2h or 3d, or a local time such as 2026-10-20 09:00",
    validateInput: (value) =>
      parseCustomSnooze(value, new Date()) === null && value.trim() !== ""
        ? "Enter a future time: 45m, 2h, 3d, or YYYY-MM-DD HH:MM."
        : undefined,
  });
  return text === undefined ? undefined : (parseCustomSnooze(text, new Date()) ?? undefined);
}

const DURATION_UNITS = { m: "minutes", h: "hours", d: "days" } as const;

/** A typed snooze, through upstream's resolver: "45m", "2h", "3d", or "YYYY-MM-DD HH:MM". */
export function parseCustomSnooze(text: string, now: Date): string | null {
  const value = text.trim();
  const duration = /^(\d+(?:\.\d+)?)\s*([mhd])$/i.exec(value);
  if (duration !== null) {
    const unit = DURATION_UNITS[duration[2]!.toLowerCase() as keyof typeof DURATION_UNITS];
    return resolveCustomSnooze({ mode: "duration", amount: duration[1]!, unit }, now);
  }
  const date = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(value);
  if (date !== null) {
    return resolveCustomSnooze({ mode: "date", date: date[1]!, time: date[2]! }, now);
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}
