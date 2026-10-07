import type { BearerConnectionProfile } from "@t3tools/client-runtime/connection";
import type { ResolvedRemotePairingTarget } from "@t3tools/shared/remote";
import * as vscode from "vscode";

import type { EnvironmentCatalog } from "./connection/catalog.ts";
import { parseConnectInput } from "./connection/pairing.ts";
import { ProbeError } from "./connection/probe.ts";
import type { WindowConnection } from "./connection/service.ts";

export function registerCommands(catalog: EnvironmentCatalog, connection: WindowConnection) {
  return [
    vscode.commands.registerCommand("pult.connect", (pairingLink?: unknown) =>
      typeof pairingLink === "string"
        ? connectLink(connection, pairingLink)
        : connect(catalog, connection),
    ),
    vscode.commands.registerCommand("pult.disconnect", () => connection.disconnect()),
    vscode.commands.registerCommand("pult.forget", () => forget(catalog, connection)),
  ];
}

/**
 * Connects the window to an environment: one from the catalog, or one added by
 * pairing. A bound window offers to disconnect first, since a window holds one
 * environment and another environment belongs in a new window.
 */
async function connect(catalog: EnvironmentCatalog, connection: WindowConnection) {
  const bound = connection.environment;
  if (bound !== null) {
    const retry = "Retry Now";
    const disconnect = "Disconnect";
    const another =
      "Disconnect to connect this window to another environment, or open another environment in a new window.";
    const choice = await vscode.window.showInformationMessage(
      `This window is connected to ${bound.label} (${bound.phase}).`,
      {
        modal: true,
        // An unsupported environment's error names its own way out.
        detail: [bound.error, bound.unsupported ? null : another]
          .filter((paragraph) => paragraph !== null)
          .join("\n\n"),
      },
      // The registry never retries an unsupported environment.
      ...(bound.phase === "ready" || bound.unsupported ? [disconnect] : [retry, disconnect]),
    );
    if (choice === retry) return connection.retryNow();
    if (choice !== disconnect) return;
    await connection.disconnect();
  }

  const environments = catalog.list();
  const picked =
    environments.length === 0
      ? "add"
      : await pick<BearerConnectionProfile | "add">(
          [
            ...environments.map((profile) => ({
              label: profile.label,
              description: new URL(profile.httpBaseUrl).host,
              profile,
            })),
            { label: "$(add) Add environment…", profile: "add" as const },
          ],
          "Connect this window to an environment",
        );
  if (picked === undefined) return;
  if (picked === "add") return add(connection);
  return reconnect(catalog, connection, picked);
}

/** Connects a catalog environment, asking for a new token while the saved one is refused. */
async function reconnect(
  catalog: EnvironmentCatalog,
  connection: WindowConnection,
  profile: BearerConnectionProfile,
) {
  let credential = await catalog.credential(profile.environmentId);
  for (;;) {
    credential ??= await askToken(profile.label);
    if (credential === undefined) return;
    const target = { httpBaseUrl: profile.httpBaseUrl, wsBaseUrl: profile.wsBaseUrl, credential };
    const outcome = await attach(connection, target, profile);
    if (outcome !== "auth") return;
    credential = undefined;
  }
}

/** Adds an environment from a pairing link, or from a server URL and its token. */
async function add(connection: WindowConnection) {
  const value = await vscode.window.showInputBox({
    title: "Add a T3 Code environment",
    prompt: "A pairing link from `t3 pair`, or the server's URL",
    placeHolder: "https://host/pair#token=…  or  http://localhost:3773",
    ignoreFocusOut: true,
    validateInput: (text) => {
      const input = parseConnectInput(text);
      return input._tag === "Invalid" && text.trim() !== "" ? input.message : undefined;
    },
  });
  if (value === undefined) return;
  const input = parseConnectInput(value);
  switch (input._tag) {
    case "Invalid":
      return vscode.window.showErrorMessage(input.message);
    case "PairingLink":
      return attach(connection, input.target);
    case "ServerUrl": {
      const token = await askToken(input.host);
      if (token === undefined) return;
      return attach(connection, input.withToken(token));
    }
  }
}

/** `pult.connect` with a pairing link: no prompts, and a failure throws to the caller. */
async function connectLink(connection: WindowConnection, pairingLink: string) {
  const input = parseConnectInput(pairingLink);
  if (input._tag !== "PairingLink") throw new Error(`Not a pairing link: ${pairingLink}`);
  if (connection.environment !== null) await connection.disconnect();
  await connection.connect(await connection.probe({ target: input.target }));
}

/**
 * Probes the target and, only if it answers, saves it, binds the window and
 * starts the connection. A failure is shown with its cause.
 */
async function attach(
  connection: WindowConnection,
  target: ResolvedRemotePairingTarget,
  expected?: BearerConnectionProfile,
): Promise<"connected" | ProbeError["kind"]> {
  const host = new URL(target.httpBaseUrl).host;
  try {
    const registration = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Pult: connecting to ${host}…` },
      () =>
        connection.probe({
          target,
          ...(expected === undefined ? {} : { expectedEnvironmentId: expected.environmentId }),
        }),
    );
    await connection.connect(registration);
    return "connected";
  } catch (error) {
    if (!(error instanceof ProbeError)) throw error;
    void vscode.window.showErrorMessage(`Pult could not connect to ${host}. ${error.detail}`);
    return error.kind;
  }
}

function askToken(name: string) {
  return vscode.window.showInputBox({
    title: `Token for ${name}`,
    prompt: "A pairing code from `t3 pair`, or a session token from `t3 auth session issue`",
    password: true,
    ignoreFocusOut: true,
    validateInput: (text) => (text.trim() === "" ? "Enter the token." : undefined),
  });
}

/** Removes an environment's profile and credential; every window bound to it disconnects. */
async function forget(catalog: EnvironmentCatalog, connection: WindowConnection) {
  const environments = catalog.list();
  if (environments.length === 0) {
    return vscode.window.showInformationMessage("Pult has no saved environments.");
  }
  const profile = await pick(
    environments.map((profile) => ({
      label: profile.label,
      description: new URL(profile.httpBaseUrl).host,
      profile,
    })),
    "Forget an environment",
  );
  if (profile === undefined) return;
  const confirm = "Forget";
  const choice = await vscode.window.showWarningMessage(
    `Forget ${profile.label}?`,
    {
      modal: true,
      detail:
        "Every window connected to it disconnects, and connecting it again takes a new pairing.",
    },
    confirm,
  );
  if (choice !== confirm) return;
  if (connection.environment?.environmentId === profile.environmentId) {
    await connection.disconnect();
  }
  await catalog.forget(profile.environmentId);
}

async function pick<T>(
  items: ReadonlyArray<vscode.QuickPickItem & { readonly profile: T }>,
  placeHolder: string,
): Promise<T | undefined> {
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.profile;
}
