// pnpm test:web, the headless load: builds the extension and extension/test/load.ts,
// then @vscode/test-web runs it in VS Code for the Web, in headless Chromium on port
// 3917, or PULT_TEST_WEB_PORT. PULT_TEST_PAIRING_LINK, a pairing link or
// `<server>/#token=<session token>`, also connects to that server and opens a thread
// tab; PULT_TEST_SEND=1 then sends a message from the tab, which runs an agent turn;
// PULT_TEST_RECONNECT=1 waits for the connection to drop and come back while you
// restart the server.
//
// PULT_TEST_FOLDER, `pult://<environment id>/<path>` naming a scratch directory on the
// server's machine, which must be this one, also opens it as the workspace folder. The
// run seeds it with hello.txt for the load to read and write and, once the load writes
// .pult-test-change, changes hello.txt on disk for the open tab to pick up through the
// server's watch; link.txt, a symlink to hello.txt, the load opens; pixel.bin, binary, the
// load reads over the asset route. PULT_TEST_STOCK=1 makes the workspace treat the server
// as stock.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const extension = NodePath.resolve(import.meta.dirname, "../extension");
const folder = process.env.PULT_TEST_FOLDER ?? "";
const folderPath = folder === "" ? undefined : decodeURIComponent(new URL(folder).pathname);

function run(args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("pnpm", args, { cwd: extension, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["run", "build"]);
run([
  "exec",
  "esbuild",
  "test/load.ts",
  "--bundle",
  "--platform=browser",
  "--format=cjs",
  "--target=es2022",
  "--external:vscode",
  "--outfile=dist/web/test/load.js",
  `--define:PULT_TEST_PAIRING_LINK=${JSON.stringify(process.env.PULT_TEST_PAIRING_LINK ?? "")}`,
  `--define:PULT_TEST_RECONNECT=${String(process.env.PULT_TEST_RECONNECT === "1")}`,
  `--define:PULT_TEST_FOLDER=${JSON.stringify(folder)}`,
  `--define:PULT_TEST_STOCK=${String(process.env.PULT_TEST_STOCK === "1")}`,
  `--define:PULT_TEST_SEND=${String(process.env.PULT_TEST_SEND === "1")}`,
]);

if (folderPath !== undefined) {
  NodeFS.mkdirSync(folderPath, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(folderPath, "hello.txt"), "hello\n");
  NodeFS.writeFileSync(NodePath.join(folderPath, "pixel.bin"), new Uint8Array([0x89, 0, 0xff, 1]));
  for (const name of [".pult-test-change", "link.txt", "hello copy.txt", "pixel copy.bin"]) {
    NodeFS.rmSync(NodePath.join(folderPath, name), { force: true });
  }
  NodeFS.symlinkSync("hello.txt", NodePath.join(folderPath, "link.txt"));
}
const load = NodeChildProcess.spawn(
  "pnpm",
  [
    "exec",
    "vscode-test-web",
    "--browserType=chromium",
    "--headless",
    "--quality=stable",
    `--port=${process.env.PULT_TEST_WEB_PORT ?? "3917"}`,
    "--extensionDevelopmentPath=.",
    "--extensionTestsPath=dist/web/test/load.js",
    ...(folder === "" ? [] : [`--folder-uri=${folder}`]),
  ],
  { cwd: extension, stdio: "inherit" },
);
// The host's side of a watched change: an agent editing hello.txt behind the editor's back.
const watcher =
  folderPath === undefined
    ? undefined
    : NodeFS.watch(folderPath, (_event, name) => {
        if (name !== ".pult-test-change") return;
        if (!NodeFS.existsSync(NodePath.join(folderPath, name))) return;
        NodeFS.appendFileSync(NodePath.join(folderPath, "hello.txt"), "changed on the host\n");
        watcher?.close();
      });
load.on("exit", (code) => {
  watcher?.close();
  process.exit(code ?? 1);
});
