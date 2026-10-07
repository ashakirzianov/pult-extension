import {
  type ConnectionCatalogEntry,
  type PreparedConnection,
  presentConnectionState,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import type * as Option from "effect/Option";

export type ConnectionPhase = "connecting" | "ready" | "reconnecting" | "offline" | "blocked";

/** The environment this window is bound to, as its connection stands. */
export interface BoundEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly phase: ConnectionPhase;
  /** Why the connection is not ready and, when only the user can fix it, how. */
  readonly error: string | null;
  /**
   * The server speaks another protocol version than this build of Pult. The
   * registry switches the environment off and never retries it: only Disconnect,
   * and Connect after Pult or the server is updated, clear it.
   */
  readonly unsupported: boolean;
  /** The projects and threads, once the first snapshot arrived. */
  readonly shell: Option.Option<OrchestrationV2ShellSnapshot>;
  /**
   * The base URL and HTTP authorization of the live connection, for HTTP routes
   * a socket does not carry, such as assets.
   */
  readonly prepared: Option.Option<PreparedConnection>;
}

/** The bound environment from the registry's current entry for it and its supervisor's state. */
export function presentBoundEnvironment(
  entry: ConnectionCatalogEntry,
  state: SupervisorConnectionState,
  shell: Option.Option<OrchestrationV2ShellSnapshot>,
  prepared: Option.Option<PreparedConnection>,
): BoundEnvironment {
  const bound = {
    environmentId: entry.target.environmentId,
    label: entry.target.label,
    shell,
    prepared,
  };
  const connection = presentConnectionState(state);
  // An unsupported server blocks the supervisor; the registry then switches the
  // entry off and keeps the verdict there, which leaves the supervisor
  // `available` with no error. The extension never switches an entry off itself.
  if (!entry.enabled || connection.phase === "unsupported") {
    const reason =
      entry.unsupportedReason ??
      connection.error ??
      `${entry.target.label} does not support this version of Pult.`;
    return {
      ...bound,
      phase: "blocked",
      error: `${reason} Disconnect, then connect again after the update.`,
      unsupported: true,
    };
  }
  const phase: ConnectionPhase = (() => {
    switch (connection.phase) {
      case "connected":
        return "ready";
      case "available":
      case "connecting":
        return "connecting";
      case "reconnecting":
        return "reconnecting";
      case "offline":
        return "offline";
      case "error":
        return "blocked";
    }
  })();
  return { ...bound, phase, error: connection.error, unsupported: false };
}
