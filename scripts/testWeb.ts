// pnpm test:web, the headless load: builds the extension and extension/test/load.ts,
// then @vscode/test-web runs it in VS Code for the Web, in headless Chromium on port
// 3917. PULT_TEST_PAIRING_LINK, a pairing link or `<server>/#token=<session token>`,
// also connects to that server; PULT_TEST_RECONNECT=1 then waits for the connection
// to drop and come back while you restart the server.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const extension = NodePath.resolve(import.meta.dirname, "../extension");

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
]);
run([
  "exec",
  "vscode-test-web",
  "--browserType=chromium",
  "--headless",
  "--quality=stable",
  "--port=3917",
  "--extensionDevelopmentPath=.",
  "--extensionTestsPath=dist/web/test/load.js",
]);
