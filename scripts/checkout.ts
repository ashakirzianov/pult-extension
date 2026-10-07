// The checkout of T3 Code Extensible that the protocol packages are vendored
// from (scripts/vendor.ts): PULT_T3CODE_CHECKOUT, from the environment or .env,
// by default ~/repos/t3code-extensible.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export const T3CODE_CHECKOUT_VARIABLE = "PULT_T3CODE_CHECKOUT";
const DEFAULT_CHECKOUT = "~/repos/t3code-extensible";

const ENV_FILE = NodePath.resolve(import.meta.dirname, "../.env");

/** The fork checkout named by PULT_T3CODE_CHECKOUT (environment or .env), or the default. */
export function t3codeCheckoutPath(): string {
  const fileEnv = NodeFS.existsSync(ENV_FILE)
    ? NodeUtil.parseEnv(NodeFS.readFileSync(ENV_FILE, "utf8"))
    : {};
  const env = { ...fileEnv, ...process.env };
  const raw = env[T3CODE_CHECKOUT_VARIABLE]?.trim() || DEFAULT_CHECKOUT;
  return NodePath.resolve(raw.replace(/^~(?=$|[/\\])/, NodeOS.homedir()));
}
