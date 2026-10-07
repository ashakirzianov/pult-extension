import {
  type BearerConnectionRegistration,
  Connection,
  type ConnectionCatalogEntry,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type PreparedConnection,
  presentConnectionState,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  type EnvironmentShellState,
  makeEnvironmentShellState,
  ShellSnapshotLoader,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as vscode from "vscode";

import { catalogLayer, type EnvironmentCatalog, type WindowBinding } from "./catalog.ts";
import { platformLayer } from "./platform.ts";
import { probe, type ProbeInput } from "./probe.ts";

export type ConnectionPhase = "connecting" | "ready" | "reconnecting" | "offline" | "blocked";

/** The environment this window is bound to, as its connection stands. */
export interface BoundEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly phase: ConnectionPhase;
  /** Why the last attempt failed, while the connection is not ready. */
  readonly error: string | null;
  /** The projects and threads, once the first snapshot arrived. */
  readonly shell: Option.Option<OrchestrationV2ShellSnapshot>;
  /**
   * The base URL and HTTP authorization of the live connection, for HTTP routes
   * a socket does not carry, such as assets.
   */
  readonly prepared: Option.Option<PreparedConnection>;
}

/**
 * The window's one connection, owned by the extension host: the vendored
 * registry, holding at most the bound environment, whose supervisor reconnects
 * it. Webviews get this state by message, never a connection of their own.
 */
export class WindowConnection implements vscode.Disposable {
  private readonly runtime;
  private readonly binding: WindowBinding;
  private current: BoundEnvironment | null = null;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;

  constructor(catalog: EnvironmentCatalog, binding: WindowBinding) {
    this.binding = binding;
    this.runtime = ManagedRuntime.make(
      Layer.mergeAll(Connection.layer, ShellSnapshotLoader.layer).pipe(
        Layer.provideMerge(Layer.mergeAll(platformLayer, catalogLayer(catalog, binding))),
      ),
    );
    this.runtime.runFork(
      followBoundEnvironment((next) => {
        this.current = next;
        this.changes.fire();
      }),
    );
  }

  get environment(): BoundEnvironment | null {
    return this.current;
  }

  /** Probes an environment from this extension host, whose origin the server sees. */
  probe(input: Omit<ProbeInput, "origin">): Promise<BearerConnectionRegistration> {
    return this.runtime.runPromise(probe({ ...input, origin: globalThis.origin }));
  }

  /**
   * Saves a probed environment to the catalog, binds the window to it, and
   * connects. Any other environment the window held is disconnected first.
   */
  connect(registration: BearerConnectionRegistration): Promise<void> {
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        for (const environmentId of (yield* SubscriptionRef.get(registry.entries)).keys()) {
          if (environmentId !== registration.target.environmentId) {
            yield* registry.remove(environmentId);
          }
        }
        yield* registry.register(registration);
      }),
    );
  }

  /** Closes the connection and unbinds the window; the catalog keeps the environment. */
  disconnect(): Promise<void> {
    const environmentId = this.binding.environmentId;
    if (environmentId === undefined) return Promise.resolve();
    return this.runtime.runPromise(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.remove(environmentId)),
        // A binding the registry never loaded, its profile gone, only needs clearing.
        Effect.catchTag("EnvironmentNotRegisteredError", () =>
          Effect.promise(() => this.binding.unbind()),
        ),
      ),
    );
  }

  retryNow(): Promise<void> {
    const environmentId = this.binding.environmentId;
    if (environmentId === undefined) return Promise.resolve();
    return this.runtime.runPromise(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.retryNow(environmentId)),
      ),
    );
  }

  dispose(): void {
    this.changes.dispose();
    void this.runtime.dispose();
  }
}

function followBoundEnvironment(publish: (next: BoundEnvironment | null) => void) {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.map((entries) => Option.fromUndefinedOr(entries.values().next().value)),
      Stream.changesWith(
        Option.makeEquivalence<ConnectionCatalogEntry>(
          (left, right) => left.target.environmentId === right.target.environmentId,
        ),
      ),
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.succeed(null),
          onSome: (entry) => registry.followStream(entry.target.environmentId, watch(entry)),
        }),
      ),
      Stream.runForEach((next) => Effect.sync(() => publish(next))),
    );
  });
}

function watch(entry: ConnectionCatalogEntry) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const shell = yield* makeEnvironmentShellState();
      return Stream.zipLatestAll(
        SubscriptionRef.changes(supervisor.state),
        SubscriptionRef.changes(shell),
        SubscriptionRef.changes(supervisor.prepared),
      ).pipe(Stream.map(([state, shell, prepared]) => present(entry, state, shell, prepared)));
    }),
  );
}

function present(
  entry: ConnectionCatalogEntry,
  state: SupervisorConnectionState,
  shell: EnvironmentShellState,
  prepared: Option.Option<PreparedConnection>,
): BoundEnvironment {
  const connection = presentConnectionState(state);
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
      case "unsupported":
        return "blocked";
    }
  })();
  return {
    environmentId: entry.target.environmentId,
    label: entry.target.label,
    phase,
    error: connection.error,
    shell: shell.snapshot,
    prepared,
  };
}
