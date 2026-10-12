import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  type EnvironmentRpcInput,
  EnvironmentRpcUnavailableError,
  type EnvironmentUnaryRpcTag,
  getInitialServerConfig,
  request,
  type RpcSession,
} from "@t3tools/client-runtime/rpc";
import { type ProjectWatchEntriesEvent, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { WindowBinding } from "../connection/catalog.ts";
import type { BoundEnvironment } from "../connection/presentation.ts";
import type { WindowConnection } from "../connection/service.ts";
import { featuresOf, type WorkspaceServer } from "./files.ts";

const STOCK_FEATURES = featuresOf({});

/** How long a call waits for a connecting window before it fails as unavailable. */
const READY_TIMEOUT_MS = 15_000;

/**
 * The workspace's server: the window's connection. A call made while the
 * window connects, as when VS Code restores a `pult:` workspace at startup,
 * waits for it; an offline or blocked window fails the call at once. While
 * `stock` holds, the server is taken to advertise none of the fork's features,
 * which is how the headless load exercises a stock server's behaviour.
 */
export function connectionServer(
  connection: WindowConnection,
  binding: WindowBinding,
  stock: () => boolean,
): WorkspaceServer {
  const ready = () => whenReady(connection, binding);
  const call = async <Tag extends EnvironmentUnaryRpcTag>(
    tag: Tag,
    input: EnvironmentRpcInput<Tag>,
  ) => {
    await ready();
    return connection.run(request(tag, input));
  };
  return {
    features: async () => {
      await ready();
      if (stock()) return STOCK_FEATURES;
      return featuresOf(await connection.run(getInitialServerConfig()));
    },
    listEntries: (input) => call(WS_METHODS.projectsListEntries, input),
    readFile: (input) => call(WS_METHODS.projectsReadFile, input),
    statEntry: (input) => call(WS_METHODS.projectsStatEntry, input),
    writeFile: (input) => call(WS_METHODS.projectsWriteFile, input),
    createDirectory: (input) => call(WS_METHODS.projectsCreateDirectory, input),
    deleteEntry: (input) => call(WS_METHODS.projectsDeleteEntry, input),
    renameEntry: (input) => call(WS_METHODS.projectsRenameEntry, input),
    searchEntries: (input) => call(WS_METHODS.projectsSearchEntries, input),
    searchContents: (input) => call(WS_METHODS.projectsSearchContents, input),
    // A signed download URL, valid an hour: minted per read and never handed on.
    readAsset: async (cwd, relativePath) => {
      const { relativeUrl } = await call(WS_METHODS.assetsCreateUrl, {
        resource: { _tag: "draft-workspace-file", cwd, path: relativePath },
      });
      const environment = connection.environment;
      const prepared =
        environment === null ? undefined : Option.getOrUndefined(environment.prepared);
      if (prepared === undefined) throw unavailable(environment);
      const authorization = prepared.httpAuthorization;
      const response = await fetch(new URL(relativeUrl, prepared.httpBaseUrl), {
        headers:
          authorization?._tag === "Bearer"
            ? { authorization: `Bearer ${authorization.token}` }
            : {},
      });
      if (!response.ok) {
        throw new Error(
          `The server refused the bytes of ${relativePath}: HTTP ${response.status}.`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    watchEntries: (cwd, listener) =>
      connection.follow(watchStream(cwd), (item) => {
        switch (item._tag) {
          case "subscribed":
            return void listener.subscribed();
          case "changed":
            return listener.changed(item.event);
          case "gone":
            return listener.gone();
        }
      }),
  };
}

function whenReady(connection: WindowConnection, binding: WindowBinding): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      const environment = connection.environment;
      if (environment?.phase === "ready") {
        resolve();
        return true;
      }
      // A bound window publishes its environment shortly after activation.
      const waiting =
        environment === null
          ? binding.environmentId !== undefined
          : environment.phase === "connecting" || environment.phase === "reconnecting";
      if (waiting) return false;
      reject(unavailable(environment));
      return true;
    };
    if (settle()) return;
    const listener = connection.onDidChange(() => {
      if (!settle()) return;
      clearTimeout(timer);
      listener.dispose();
    });
    const timer = setTimeout(() => {
      listener.dispose();
      reject(unavailable(connection.environment));
    }, READY_TIMEOUT_MS);
  });
}

function unavailable(environment: BoundEnvironment | null) {
  return new EnvironmentRpcUnavailableError({
    environmentId: environment?.environmentId ?? "",
    message:
      environment === null
        ? "This window is not connected to a Pult environment."
        : (environment.error ?? `${environment.label} is ${environment.phase}.`),
  });
}

type WatchItem =
  | { readonly _tag: "subscribed" }
  | { readonly _tag: "changed"; readonly event: ProjectWatchEntriesEvent }
  | { readonly _tag: "gone" };

const subscribed: WatchItem = { _tag: "subscribed" };
const gone: WatchItem = { _tag: "gone" };

/**
 * A root's changes: a subscription on each session the supervisor opens, again
 * whenever the server's watcher closes, ending for good once the root is gone.
 * Any other failure waits for the next session.
 */
function watchStream(
  cwd: string,
): Stream.Stream<WatchItem, never, EnvironmentSupervisor.EnvironmentSupervisor> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      return SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => watchSession(session, cwd),
          }),
        ),
        Stream.takeUntil((item) => item._tag === "gone"),
      );
    }),
  );
}

function watchSession(session: RpcSession, cwd: string): Stream.Stream<WatchItem> {
  return Stream.succeed(subscribed).pipe(
    Stream.concat(
      session.client[WS_METHODS.projectsWatchEntries]({ cwd }).pipe(
        Stream.map((event): WatchItem => ({ _tag: "changed", event })),
      ),
    ),
    // The server's watcher closed: subscribe again.
    Stream.concat(Stream.suspend(() => watchSession(session, cwd))),
    Stream.catch((error) =>
      error._tag === "ProjectWatchEntriesError" && error.failure === "workspace_root_not_found"
        ? Stream.succeed(gone)
        : Stream.empty,
    ),
  );
}
