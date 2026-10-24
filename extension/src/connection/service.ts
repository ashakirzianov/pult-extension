import {
  type BearerConnectionRegistration,
  Connection,
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import {
  makeEnvironmentShellState,
  ShellSnapshotLoader,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as vscode from "vscode";

import type { SocketHub } from "../threads/socketHub.ts";
import { catalogLayer, type EnvironmentCatalog, type WindowBinding } from "./catalog.ts";
import { platformLayer } from "./platform.ts";
import { type BoundEnvironment, presentBoundEnvironment } from "./presentation.ts";
import { probe, type ProbeInput } from "./probe.ts";

/**
 * The window's one connection, owned by the extension host: the vendored
 * registry, holding at most the bound environment, whose supervisor reconnects
 * it. Its socket is the hub's, which thread tabs' webviews share; they never
 * open a connection of their own.
 */
export class WindowConnection implements vscode.Disposable {
  private readonly runtime;
  private readonly binding: WindowBinding;
  private current: BoundEnvironment | null = null;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  /** `fetch` for the environment's HTTP routes; in Pult the shell's, which holds the bearer. */
  readonly fetch: typeof globalThis.fetch;

  constructor(
    catalog: EnvironmentCatalog,
    binding: WindowBinding,
    hub: SocketHub,
    fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    this.binding = binding;
    this.fetch = fetch;
    this.runtime = ManagedRuntime.make(
      Layer.mergeAll(Connection.layer, ShellSnapshotLoader.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            platformLayer(hub.webSocketConstructor, fetch),
            catalogLayer(catalog, binding),
          ),
        ),
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

  /**
   * Runs an effect on the bound environment's supervisor: RPCs go to its live
   * session, and fail with `EnvironmentRpcUnavailableError` while there is none
   * or the window is unbound.
   */
  run<A, E>(effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor>): Promise<A> {
    const environmentId = this.binding.environmentId;
    if (environmentId === undefined) return Promise.reject(unbound());
    return this.runtime.runPromise(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.run(environmentId, effect)),
      ),
    );
  }

  /**
   * Runs a stream on the bound environment's supervisor, handing each item to
   * `onItem`, until disposed or the window unbinds from that environment.
   */
  follow<A>(
    stream: Stream.Stream<A, never, EnvironmentSupervisor.EnvironmentSupervisor>,
    onItem: (item: A) => void,
  ): vscode.Disposable {
    const environmentId = this.binding.environmentId;
    if (environmentId === undefined) return new vscode.Disposable(() => {});
    const fiber = this.runtime.runFork(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) =>
          registry
            .followStream(environmentId, stream)
            .pipe(Stream.runForEach((item) => Effect.sync(() => onItem(item)))),
        ),
      ),
    );
    return new vscode.Disposable(() => void Effect.runFork(Fiber.interrupt(fiber)));
  }

  dispose(): void {
    this.changes.dispose();
    void this.runtime.dispose();
  }
}

function unbound() {
  return new EnvironmentRpcUnavailableError({
    environmentId: "",
    message: "This window is not connected to a Pult environment.",
  });
}

function followBoundEnvironment(publish: (next: BoundEnvironment | null) => void) {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.map((entries) => Option.fromUndefinedOr(entries.keys().next().value)),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.succeed(null),
          // Every change to the entry, a learned route included, restarts
          // `followStream` and so this stream, with a fresh shell state, empty
          // until the snapshot reloads. Learned routes live in memory
          // (`catalogLayer`), so this repeats after every activation; the
          // threads model holds the last snapshot through it (`ThreadsModel`).
          onSome: (environmentId) =>
            registry.followStream(environmentId, watch(registry, environmentId)),
        }),
      ),
      Stream.runForEach((next) => Effect.sync(() => publish(next))),
    );
  });
}

function watch(
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const shell = yield* makeEnvironmentShellState();
      return Stream.zipLatestAll(
        SubscriptionRef.changes(registry.entries).pipe(
          Stream.map((entries) => entries.get(environmentId)),
          Stream.filter((entry) => entry !== undefined),
        ),
        SubscriptionRef.changes(supervisor.state),
        SubscriptionRef.changes(shell),
        SubscriptionRef.changes(supervisor.prepared),
      ).pipe(
        Stream.map(([entry, state, shell, prepared]) =>
          presentBoundEnvironment(entry, state, shell.snapshot, prepared),
        ),
      );
    }),
  );
}
