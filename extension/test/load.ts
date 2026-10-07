// The headless load, `pnpm test:web` (scripts/testWeb.ts): @vscode/test-web runs this
// in VS Code for the Web's web worker extension host, beside the extension, and fails
// the run on a throw. Given a server, it connects to it the way `pult.connect` does.
import * as Option from "effect/Option";
import * as vscode from "vscode";

import type { PultApi } from "../src/extension.ts";
import type { BoundEnvironment, WindowConnection } from "../src/connection/service.ts";

declare const PULT_TEST_PAIRING_LINK: string;
declare const PULT_TEST_RECONNECT: boolean;

const CONNECT_TIMEOUT_MS = 30_000;
const RESTART_TIMEOUT_MS = 300_000;

export async function run() {
  const extension = vscode.extensions.getExtension<PultApi>("pult.pult");
  if (extension === undefined) throw new Error("pult.pult is not installed.");
  await vscode.commands.executeCommand("workbench.view.extension.pult");
  const { connection } = await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of ["pult.connect", "pult.disconnect", "pult.forget", "pult.threads.focus"]) {
    if (!commands.includes(command)) throw new Error(`${command} is not registered.`);
  }
  console.log(`${extension.id} activated in VS Code ${vscode.version} for the Web, at ${origin}.`);
  if (PULT_TEST_PAIRING_LINK === "") return;

  await vscode.commands.executeCommand("pult.connect", PULT_TEST_PAIRING_LINK);
  const listed = await until(connection, "lists projects", listsProjects, CONNECT_TIMEOUT_MS);
  console.log(`Connected to ${listed.label}: ${describe(listed)}.`);

  if (PULT_TEST_RECONNECT) {
    console.log("Restart the server: the connection must drop and come back.");
    await until(
      connection,
      "loses the connection",
      (environment): environment is BoundEnvironment | null => environment?.phase !== "ready",
      RESTART_TIMEOUT_MS,
    );
    const back = await until(connection, "reconnects", listsProjects, RESTART_TIMEOUT_MS);
    console.log(`Reconnected to ${back.label}: ${describe(back)}.`);
  }

  await vscode.commands.executeCommand("pult.disconnect");
  await until(connection, "unbinds", (environment) => environment === null, CONNECT_TIMEOUT_MS);
}

function listsProjects(environment: BoundEnvironment | null): environment is BoundEnvironment {
  return (
    environment?.phase === "ready" &&
    Option.isSome(environment.shell) &&
    environment.shell.value.projects.length > 0
  );
}

function describe(environment: BoundEnvironment): string {
  const shell = Option.getOrThrow(environment.shell);
  return `${shell.projects.length} projects, ${shell.threads.length} threads`;
}

/** Resolves on the connection change that meets `condition`; fails the run if none does in time. */
function until<T extends BoundEnvironment | null>(
  connection: WindowConnection,
  description: string,
  condition: (environment: BoundEnvironment | null) => environment is T,
  timeoutMs: number,
) {
  return new Promise<T>((resolve, reject) => {
    const check = () => {
      const environment = connection.environment;
      if (!condition(environment)) return;
      cleanup();
      resolve(environment);
    };
    const listener = connection.onDidChange(check);
    const timer = setTimeout(() => {
      cleanup();
      const environment = connection.environment;
      const state =
        environment === null
          ? "unbound"
          : `${environment.phase}${environment.error === null ? "" : `: ${environment.error}`}`;
      reject(new Error(`The connection never ${description}; it is ${state}.`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      listener.dispose();
    };
    check();
  });
}
