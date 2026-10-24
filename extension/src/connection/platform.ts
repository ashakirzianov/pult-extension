import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionBlockedError,
  Connectivity,
  type NetworkStatus,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { ClientCapabilities, PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as vscode from "vscode";

const unsupported = (detail: string) =>
  Effect.fail(new ConnectionBlockedError({ reason: "unsupported", detail }));

function networkStatus(): NetworkStatus {
  return navigator.onLine ? "online" : "offline";
}

const connectivityLayer = Connectivity.layer({
  status: Effect.sync(networkStatus),
  changes: Stream.callback<NetworkStatus>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        globalThis.addEventListener("online", online);
        globalThis.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          globalThis.removeEventListener("online", online);
          globalThis.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

// Returning to the window probes the socket and cuts a retry's wait short.
const wakeupsLayer = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        vscode.window.onDidChangeWindowState((state) => {
          if (state.focused) Queue.offerUnsafe(queue, "application-active");
        }),
      ),
      (listener) => Effect.sync(() => listener.dispose()),
    ).pipe(Effect.asVoid),
  ),
});

const capabilitiesLayer = Layer.mergeAll(
  Layer.succeed(ClientCapabilities.ClientPresentation, {
    metadata: { label: "Pult for VS Code", deviceType: "desktop" },
    scopes: AuthStandardClientScopes,
  }),
  Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, { bearerToken: Effect.succeedNone }),
  Layer.succeed(ClientCapabilities.CloudSession, {
    identity: Effect.succeedNone,
    clerkToken: unsupported("T3 Connect is not available in Pult for VS Code."),
  }),
  Layer.succeed(ClientCapabilities.RelayDeviceIdentity, { deviceId: Effect.succeedNone }),
  Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
    provision: () => unsupported("SSH environments are not available in Pult for VS Code."),
    prepare: () => unsupported("SSH environments are not available in Pult for VS Code."),
    disconnect: () => Effect.void,
  }),
  TokenStore.layer({
    get: () => Effect.succeedNone,
    put: () => Effect.void,
    remove: () => Effect.void,
  }),
  Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, {
    thumbprint: Effect.fail(
      new ManagedRelay.ManagedRelayDpopKeyLoadError({
        keyStore: "indexed-db",
        cause: "T3 Connect is not available in Pult for VS Code.",
      }),
    ),
    createProof: (input) =>
      Effect.fail(
        new ManagedRelay.ManagedRelayDpopProofCreationError({
          method: input.method,
          url: input.url,
          cause: "T3 Connect is not available in Pult for VS Code.",
        }),
      ),
  }),
);

/**
 * What the vendored connection runtime asks of its host, for a web worker
 * extension host: the given fetch and WebSocket constructor (in Pult, the
 * shell's, `shell.ts`), the worker's
 * network events, window focus as the wakeup, and direct routes only. T3
 * Connect (an empty relay URL disables the relay client), SSH and a primary
 * local environment are the Pult desktop's.
 */
export function platformLayer(
  webSocketConstructor: Socket.WebSocketConstructor["Service"],
  fetch: typeof globalThis.fetch,
) {
  return ManagedRelay.layer({ relayUrl: "", clientId: "t3-web" }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FetchHttpClient.layer.pipe(Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor),
        connectivityLayer,
        wakeupsLayer,
        capabilitiesLayer,
        Layer.succeed(PlatformConnectionSource.PlatformConnectionSource, {
          registrations: Stream.empty,
        }),
      ),
    ),
  );
}
