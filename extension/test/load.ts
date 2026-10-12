// The headless load, `pnpm test:web` (scripts/testWeb.ts): @vscode/test-web runs this
// in VS Code for the Web's web worker extension host, beside the extension, and fails
// the run on a throw. Given a server, it connects to it the way `pult.connect` does;
// given a `pult:` folder too, it reads and writes there.
import * as Option from "effect/Option";
import * as vscode from "vscode";

import type { PultTestApi } from "../src/extension.ts";

declare const PULT_TEST_PAIRING_LINK: string;
declare const PULT_TEST_RECONNECT: boolean;
declare const PULT_TEST_FOLDER: string;
declare const PULT_TEST_STOCK: boolean;

const CONNECT_TIMEOUT_MS = 30_000;
const RESTART_TIMEOUT_MS = 300_000;
const WATCH_TIMEOUT_MS = 10_000;

export async function run() {
  const extension = vscode.extensions.getExtension<PultTestApi | undefined>("pult.pult");
  if (extension === undefined) throw new Error("pult.pult is not installed.");
  await vscode.commands.executeCommand("workbench.view.extension.pult");
  const connection = await extension.activate();
  if (connection === undefined) throw new Error("pult.pult runs in production mode: no test API.");
  const commands = await vscode.commands.getCommands(true);
  for (const command of ["pult.connect", "pult.disconnect", "pult.forget", "pult.threads.focus"]) {
    if (!commands.includes(command)) throw new Error(`${command} is not registered.`);
  }
  console.log(`${extension.id} activated in VS Code ${vscode.version} for the Web, at ${origin}.`);
  if (PULT_TEST_PAIRING_LINK === "") return;

  if (PULT_TEST_STOCK) connection.simulateStockServer();
  await vscode.commands.executeCommand("pult.connect", PULT_TEST_PAIRING_LINK);
  const listed = await until(connection, "lists projects", listsProjects, CONNECT_TIMEOUT_MS);
  console.log(`Connected to ${listed.label}: ${describe(listed)}.`);
  if (PULT_TEST_FOLDER !== "") await useFolder(vscode.Uri.parse(PULT_TEST_FOLDER));

  if (PULT_TEST_RECONNECT) {
    console.log("Restart the server: the connection must drop and come back.");
    await until(
      connection,
      "loses the connection",
      (environment): environment is Environment | null => environment?.phase !== "ready",
      RESTART_TIMEOUT_MS,
    );
    const back = await until(connection, "reconnects", listsProjects, RESTART_TIMEOUT_MS);
    console.log(`Reconnected to ${back.label}: ${describe(back)}.`);
  }

  await vscode.commands.executeCommand("pult.disconnect");
  await until(connection, "unbinds", (environment) => environment === null, CONNECT_TIMEOUT_MS);
}

/**
 * The folder testWeb.ts seeded: read and write hello.txt, then, on a stock server, see a
 * binary read and a file creation refused, or else read pixel.bin's bytes, and have the run
 * change hello.txt on disk and see its open document pick the change up through the
 * server's watch, with no turn ending.
 */
async function useFolder(folder: vscode.Uri) {
  const opened = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (opened?.toString() !== folder.toString()) {
    throw new Error(`The workspace folder is ${String(opened)}, not ${folder.toString()}.`);
  }
  const entries = await vscode.workspace.fs.readDirectory(folder);
  if (!entries.some(([name]) => name === "hello.txt")) {
    throw new Error(`${folder.toString()} lists no hello.txt.`);
  }
  const hello = vscode.Uri.joinPath(folder, "hello.txt");
  const document = await vscode.workspace.openTextDocument(hello);
  if (document.getText() !== "hello\n") throw new Error(`hello.txt reads ${document.getText()}.`);
  const written = "written by the headless load\n";
  await vscode.workspace.fs.writeFile(hello, new TextEncoder().encode(written));
  const read = new TextDecoder().decode(await vscode.workspace.fs.readFile(hello));
  if (read !== written) throw new Error(`hello.txt reads ${read} after the write.`);
  console.log(`Read and wrote hello.txt in ${folder.toString()}.`);

  const pixel = vscode.Uri.joinPath(folder, "pixel.bin");
  const marker = vscode.Uri.joinPath(folder, ".pult-test-change");
  if (PULT_TEST_STOCK) {
    const unreadable = await vscode.workspace.fs.readFile(pixel).then(
      () => false,
      (error: unknown) => error instanceof vscode.FileSystemError && error.code === "Unavailable",
    );
    if (!unreadable) throw new Error("The workspace read a binary file from a stock server.");
    const refused = await vscode.workspace.fs.writeFile(marker, new Uint8Array()).then(
      () => false,
      (error: unknown) => error instanceof vscode.FileSystemError && error.code === "NoPermissions",
    );
    if (!refused) throw new Error("The workspace created a file on a stock server.");
    console.log("A stock server's workspace refused a binary read and a file creation.");
    return;
  }
  const bytes = [...(await vscode.workspace.fs.readFile(pixel))];
  if (bytes.join() !== "137,0,255,1") throw new Error(`pixel.bin reads ${bytes.join()}.`);
  console.log("Read pixel.bin's bytes over the asset route.");
  await vscode.workspace.fs.writeFile(marker, new Uint8Array());
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!document.getText().includes("changed on the host")) return;
      cleanup();
      resolve();
    };
    const listener = vscode.workspace.onDidChangeTextDocument(check);
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`hello.txt never picked up the host's change; it reads ${document.getText()}`),
      );
    }, WATCH_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      listener.dispose();
    };
    check();
  });
  await vscode.workspace.fs.delete(marker);
  console.log("The open hello.txt picked up a change on the host through the watch.");
}

type Environment = NonNullable<PultTestApi["environment"]>;

function listsProjects(environment: Environment | null): environment is Environment {
  return (
    environment?.phase === "ready" &&
    Option.isSome(environment.shell) &&
    environment.shell.value.projects.length > 0
  );
}

function describe(environment: Environment): string {
  const shell = Option.getOrThrow(environment.shell);
  return `${shell.projects.length} projects, ${shell.threads.length} threads`;
}

/** Resolves on the connection change that meets `condition`; fails the run if none does in time. */
function until<T extends Environment | null>(
  connection: PultTestApi,
  description: string,
  condition: (environment: Environment | null) => environment is T,
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
