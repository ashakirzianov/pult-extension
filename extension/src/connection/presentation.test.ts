import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { presentBoundEnvironment } from "./presentation.ts";

const environmentId = EnvironmentId.make("environment-1");
const entry: ConnectionCatalogEntry = {
  target: new BearerConnectionTarget({
    environmentId,
    label: "Studio",
    connectionId: environmentId,
  }),
  profile: Option.none(),
  enabled: true,
};
const reason = "This client is not supported by this server.";

const present = (entry: ConnectionCatalogEntry, state = AVAILABLE_CONNECTION_STATE) =>
  presentBoundEnvironment(entry, state, Option.none(), Option.none());

describe("presentBoundEnvironment", () => {
  it("shows an environment the registry switched off as unsupported, with the way out", () => {
    // What the registry leaves after an unsupported verdict: the entry off, the supervisor idle.
    const environment = present({ ...entry, enabled: false, unsupportedReason: reason });
    expect(environment).toMatchObject({ phase: "blocked", unsupported: true });
    expect(environment.error).toBe(`${reason} Disconnect, then connect again after the update.`);
  });

  it("shows the supervisor's unsupported verdict before the registry switches the entry off", () => {
    const environment = present(entry, {
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "blocked",
      lastFailure: new ConnectionBlockedError({ reason: "unsupported", detail: reason }),
    });
    expect(environment).toMatchObject({ phase: "blocked", unsupported: true });
    expect(environment.error).toContain(reason);
  });

  it("shows an enabled environment whose supervisor has not started as connecting", () => {
    expect(present(entry)).toMatchObject({ phase: "connecting", error: null, unsupported: false });
  });
});
