import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type ConnectionCredential,
  type ConnectionProfile,
  Connectivity,
  CredentialStore,
  type NetworkStatus,
  ProfileStore,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import {
  ClientCapabilities,
  Persistence,
  PlatformConnectionSource,
} from "@t3tools/client-runtime/platform";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { clearComposerDraftsEnvironment } from "../t3/src/composerDraftStore";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../t3/src/rpc/requestLatencyState";
import { onHostMessage } from "./bridge.ts";
import { session } from "./session.ts";

const unsupported = (detail: string) =>
  Effect.fail(new ConnectionBlockedError({ reason: "unsupported", detail }));

/** The bound environment, registered the way a desktop-local backend is: by the platform, with its bearer. */
function registration(): BearerConnectionRegistration {
  const { environment } = session();
  const environmentId = EnvironmentId.make(environment.environmentId);
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId,
      label: environment.label,
      connectionId: environment.connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId: environment.connectionId,
      environmentId,
      label: environment.label,
      httpBaseUrl: environment.httpBaseUrl,
      wsBaseUrl: environment.wsBaseUrl,
    }),
    credential: new BearerConnectionCredential({ token: environment.bearer }),
  });
}

/** The registry's stores, in memory: the page holds one environment for its lifetime. */
const layerStorage = Layer.mergeAll(
  Layer.sync(ProfileStore.ConnectionProfileStore, () => {
    const profiles = new Map<string, ConnectionProfile>();
    return ProfileStore.make({
      get: (connectionId) => Effect.sync(() => Option.fromUndefinedOr(profiles.get(connectionId))),
      put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
      remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
    });
  }),
  Layer.sync(CredentialStore.ConnectionCredentialStore, () => {
    const credentials = new Map<string, ConnectionCredential>();
    return CredentialStore.make({
      get: (connectionId) =>
        Effect.sync(() => Option.fromUndefinedOr(credentials.get(connectionId))),
      put: (connectionId, credential) =>
        Effect.sync(() => void credentials.set(connectionId, credential)),
      remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
    });
  }),
);

const layerPersistence = Layer.mergeAll(
  Layer.succeed(Persistence.ConnectionTargetStore, {
    list: Effect.succeed([]),
    listDisabled: Effect.succeed([]),
  }),
  Layer.succeed(Persistence.ConnectionRegistrationStore, {
    register: () => Effect.void,
    setRoutes: () => Effect.void,
    remove: () => Effect.void,
    setEnabled: () => Effect.void,
  }),
  // A tab keeps no offline copy: each page loads its thread from the server.
  Layer.succeed(Persistence.EnvironmentCacheStore, {
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  }),
  Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, {
    clear: (environmentId) => Effect.sync(() => clearComposerDraftsEnvironment(environmentId)),
  }),
  TokenStore.layer({
    get: () => Effect.succeedNone,
    put: () => Effect.void,
    remove: () => Effect.void,
  }),
);

function networkStatus(): NetworkStatus {
  return navigator.onLine ? "online" : "offline";
}

const layerConnectivity = Connectivity.layer({
  status: Effect.sync(networkStatus),
  changes: Stream.callback<NetworkStatus>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

// The host's connection coming back cuts a reconnect's wait short.
const layerWakeups = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        onHostMessage((message) => {
          if (message.type === "wakeup") Queue.offerUnsafe(queue, "application-active");
        }),
      ),
      (stop) => Effect.sync(stop),
    ).pipe(Effect.asVoid),
  ),
});

const layerCapabilities = Layer.mergeAll(
  Layer.succeed(ClientCapabilities.ClientPresentation, {
    metadata: { label: "Pult for VS Code", deviceType: "desktop" },
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
);

let nextObservedRequestId = 0;

const layerRpcRequestObserver = Layer.succeed(EnvironmentRpcRequestObserver, {
  observe: ({ environmentId, method }) =>
    Effect.sync(() => {
      nextObservedRequestId += 1;
      const requestId = `${environmentId}:${nextObservedRequestId}`;
      trackRpcRequestSent(requestId, method, `${method} · ${environmentId}`);
      return Effect.sync(() => acknowledgeRpcRequest(requestId));
    }),
});

/**
 * What the vendored runtime asks of the page, for a thread tab: the window's
 * bound environment as its one platform registration, stores in memory, and
 * T3 Connect, SSH and a primary environment switched off, as the host's are
 * (`../../src/connection/platform.ts`).
 */
export const platformLayer = Layer.mergeAll(
  layerStorage,
  layerPersistence,
  layerConnectivity,
  layerWakeups,
  layerCapabilities,
  layerRpcRequestObserver,
  Layer.sync(PlatformConnectionSource.PlatformConnectionSource, () => ({
    registrations: Stream.concat(Stream.succeed([registration()]), Stream.never),
  })),
);
