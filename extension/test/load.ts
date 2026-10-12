// The headless load, `pnpm test:web` (scripts/testWeb.ts): @vscode/test-web runs this
// in VS Code for the Web's web worker extension host, beside the extension, and fails
// the run on a throw. Given a server, it connects to it the way `pult.connect` does,
// opens a draft thread tab and waits for its page to load the project through the
// host; with PULT_TEST_SEND it also sends a message from the tab and waits for the
// agent's reply in the thread's tab, then settles, snoozes and pins the thread. Given
// a `pult:` folder too, it reads and writes there.
import * as Option from "effect/Option";
import * as vscode from "vscode";

import type { PultTestApi, TestThread } from "../src/extension.ts";
import { parseThreadUri, THREAD_VIEW_TYPE } from "../src/threads/uri.ts";

declare const PULT_TEST_PAIRING_LINK: string;
declare const PULT_TEST_RECONNECT: boolean;
declare const PULT_TEST_FOLDER: string;
declare const PULT_TEST_STOCK: boolean;
declare const PULT_TEST_SEND: boolean;

const CONNECT_TIMEOUT_MS = 30_000;
const RESTART_TIMEOUT_MS = 300_000;
const WATCH_TIMEOUT_MS = 10_000;
const PAGE_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 180_000;
// The project the test prefers, when the server has it (docs/development.md).
const SANDBOX_PROJECT = "pult-tabs-sandbox";

export async function run() {
  const extension = vscode.extensions.getExtension<PultTestApi | undefined>("pult.pult");
  if (extension === undefined) throw new Error("pult.pult is not installed.");
  await vscode.commands.executeCommand("workbench.view.extension.pult");
  const connection = await extension.activate();
  if (connection === undefined) throw new Error("pult.pult runs in production mode: no test API.");
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "pult.connect",
    "pult.disconnect",
    "pult.forget",
    "pult.threads.focus",
    "pult.newThread",
    "pult.openThread",
    "pult.settleThread",
    "pult.snoozeThread",
    "pult.pinThread",
  ]) {
    if (!commands.includes(command)) throw new Error(`${command} is not registered.`);
  }
  console.log(`${extension.id} activated in VS Code ${vscode.version} for the Web, at ${origin}.`);
  if (PULT_TEST_PAIRING_LINK === "") return;

  if (PULT_TEST_STOCK) connection.simulateStockServer();
  await vscode.commands.executeCommand("pult.connect", PULT_TEST_PAIRING_LINK);
  const listed = await until(connection, "lists projects", listsProjects, CONNECT_TIMEOUT_MS);
  console.log(`Connected to ${listed.label}: ${describe(listed)}.`);
  if (PULT_TEST_FOLDER !== "") await useFolder(vscode.Uri.parse(PULT_TEST_FOLDER));
  await threadTab(connection, listed);

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
 * The folder testWeb.ts seeded: read and write hello.txt and open link.txt, its symlink,
 * then, on a stock server, see a binary read, a file creation and a copy refused, or else
 * read pixel.bin's bytes, copy hello.txt and see pixel.bin's copy refused, and have the run
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
  const link = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, "link.txt"));
  if (link.getText() !== written) throw new Error(`link.txt reads ${link.getText()}.`);
  console.log("Opened link.txt, a symlink.");

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
    if (!(await refusesCopy(hello, vscode.Uri.joinPath(folder, "hello copy.txt")))) {
      throw new Error("The workspace copied a file on a stock server.");
    }
    console.log("A stock server's workspace refused a binary read, a file creation and a copy.");
    return;
  }
  const bytes = [...(await vscode.workspace.fs.readFile(pixel))];
  if (bytes.join() !== "137,0,255,1") throw new Error(`pixel.bin reads ${bytes.join()}.`);
  console.log("Read pixel.bin's bytes over the asset route.");
  const copy = vscode.Uri.joinPath(folder, "hello copy.txt");
  await vscode.workspace.fs.copy(hello, copy);
  const copied = new TextDecoder().decode(await vscode.workspace.fs.readFile(copy));
  if (copied !== written) throw new Error(`hello copy.txt reads ${copied}.`);
  await vscode.workspace.fs.delete(copy);
  if (!(await refusesCopy(pixel, vscode.Uri.joinPath(folder, "pixel copy.bin")))) {
    throw new Error("The workspace copied pixel.bin, which the server cannot write.");
  }
  console.log("Copied hello.txt, and refused to copy pixel.bin.");
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

function refusesCopy(source: vscode.Uri, target: vscode.Uri): Thenable<boolean> {
  return vscode.workspace.fs.copy(source, target).then(
    () => false,
    (error: unknown) => error instanceof vscode.FileSystemError && error.code === "NoPermissions",
  );
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

/** A draft tab in the sandbox project, or the first, through to a reply when PULT_TEST_SEND is set. */
async function threadTab(api: PultTestApi, environment: Environment) {
  const projects = Option.getOrThrow(environment.shell).projects;
  const project = projects.find((each) => each.title === SANDBOX_PROJECT) ?? projects[0]!;
  await vscode.commands.executeCommand("pult.newThread", project.id);
  const draft = activeThreadTab();
  if (parseThreadUri(draft)?.target.kind !== "draft") throw new Error(`No draft tab: ${draft}.`);
  // The page loaded and its runtime reached the server through the host.
  await probeUntil(
    api,
    () => draft,
    `shows ${project.title}`,
    (text) => text.includes(project.title),
  );
  console.log(`A draft tab in ${project.title} loaded.`);
  if (!PULT_TEST_SEND) {
    await closeTab(draft);
    return;
  }

  const before = new Set(api.threads.list().map((thread) => thread.id));
  await api.threads.send(
    draft.toString(),
    "Reply with the text olleh-tlup reversed, and nothing else.",
  );
  const created = await untilThread(api, "is created", (thread) => !before.has(thread.id));
  console.log(`The message created thread ${created.id}.`);
  // The draft's thread exists: its tab moved to the thread's URI.
  const tab = await poll("the draft's tab moves to its thread", PAGE_TIMEOUT_MS, () => {
    const uri = activeThreadTab();
    const resource = parseThreadUri(uri);
    return resource?.target.kind === "thread" && resource.target.threadId === created.id
      ? uri
      : undefined;
  });
  // The agent's reply streamed into the tab's own page, over its bridged socket.
  await probeUntil(
    api,
    activeThreadTab,
    "shows the agent's reply",
    (text) => text.includes("pult-hello"),
    REPLY_TIMEOUT_MS,
  );
  console.log(`Sent a message from a draft tab; its thread's tab, ${tab.path}, shows the reply.`);

  // A thread settles once its run is over.
  await untilThread(
    api,
    "finishes its run",
    (thread) => thread.id === created.id && !thread.working,
    REPLY_TIMEOUT_MS,
  );
  const threadUri = activeThreadTab();
  await vscode.commands.executeCommand("pult.settleThread", threadUri);
  await untilThread(api, "settles", (thread) => thread.id === created.id && thread.settled);
  await vscode.commands.executeCommand("pult.unsettleThread", threadUri);
  await untilThread(api, "un-settles", (thread) => thread.id === created.id && !thread.settled);
  const wake = new Date(Date.now() + 60 * 60_000).toISOString();
  await vscode.commands.executeCommand("pult.snoozeThread", threadUri, wake);
  await untilThread(api, "snoozes", (thread) => thread.id === created.id && thread.snoozed);
  await vscode.commands.executeCommand("pult.unsnoozeThread", threadUri);
  await untilThread(api, "wakes", (thread) => thread.id === created.id && !thread.snoozed);
  await vscode.commands.executeCommand("pult.pinThread", threadUri);
  await untilThread(api, "pins", (thread) => thread.id === created.id && thread.pinned);
  await vscode.commands.executeCommand("pult.unpinThread", threadUri);
  await untilThread(api, "unpins", (thread) => thread.id === created.id && !thread.pinned);
  console.log("Settled, snoozed and pinned it, and back.");
  await closeTab(threadUri);
}

function activeThreadTab(): vscode.Uri {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof vscode.TabInputCustom) || input.viewType !== THREAD_VIEW_TYPE) {
    throw new Error("The active tab is not a thread tab.");
  }
  return input.uri;
}

async function closeTab(uri: vscode.Uri) {
  const tab = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (each) =>
        each.input instanceof vscode.TabInputCustom && each.input.uri.toString() === uri.toString(),
    );
  if (tab !== undefined) await vscode.window.tabGroups.close(tab);
}

/** Resolves on the thread change that meets `condition`; fails the run if none does in time. */
function untilThread(
  api: PultTestApi,
  description: string,
  condition: (thread: TestThread) => boolean,
  timeoutMs = CONNECT_TIMEOUT_MS,
) {
  return new Promise<TestThread>((resolve, reject) => {
    const check = () => {
      const thread = api.threads.list().find(condition);
      if (thread === undefined) return;
      cleanup();
      resolve(thread);
    };
    const listener = api.threads.onDidChange(check);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`The thread never ${description}.`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      listener.dispose();
    };
    check();
  });
}

/** Waits until a tab's page text meets `condition`; a timeout reports what it showed. */
async function probeUntil(
  api: PultTestApi,
  tab: () => vscode.Uri,
  description: string,
  condition: (text: string) => boolean,
  timeoutMs = PAGE_TIMEOUT_MS,
) {
  let last = "";
  try {
    await poll(`the thread tab ${description}`, timeoutMs, async () =>
      condition((last = await api.threads.probe(tab().toString()))),
    );
  } catch (error) {
    throw new Error(`${String(error)}\nThe tab showed:\n${last.slice(0, 2_000)}`, {
      cause: error,
    });
  }
}

/** Asks until `check` answers, for what a page shows, which no event announces to the host. */
async function poll<T>(
  description: string,
  timeoutMs: number,
  check: () => T | undefined | false | Promise<T | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const result = await check();
      if (result !== undefined && result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting until ${description}${lastError === undefined ? "" : `: ${String(lastError)}`}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
