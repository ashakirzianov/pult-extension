import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type ConnectionProfile,
  CredentialStore,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import { ConnectionPersistenceError, Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as vscode from "vscode";

type Memento = Pick<vscode.Memento, "keys" | "get" | "update">;
type Secrets = Pick<vscode.SecretStorage, "get" | "store" | "delete">;

const PROFILE_KEY_PREFIX = "pult.environment/";
const CREDENTIAL_KEY_PREFIX = "pult.credential/";
const BINDING_KEY = "pult.binding";

const decodeProfile = Schema.decodeUnknownOption(BearerConnectionProfile);
const encodeProfile = Schema.encodeSync(BearerConnectionProfile);
const isBearerProfile = Schema.is(BearerConnectionProfile);

/**
 * The environments this VS Code has paired with, shared by every window: a
 * profile per environment in `globalState` and its bearer in `SecretStorage`,
 * both keyed by environment id, so an environment pairs once. The extension
 * pairs itself and never reads the Pult desktop's credential: each client is its
 * own session. `SecretStorage` is encrypted on desktop and per browser profile
 * on the web; `workspaceState` would keep the bearer in plain text on disk, and
 * the server URL as a setting would sync across machines. Anton's ruling.
 */
export class EnvironmentCatalog {
  private readonly globalState: Memento;
  private readonly secrets: Secrets;

  constructor(globalState: Memento, secrets: Secrets) {
    this.globalState = globalState;
    this.secrets = secrets;
  }

  list(): ReadonlyArray<BearerConnectionProfile> {
    return this.globalState
      .keys()
      .filter((key) => key.startsWith(PROFILE_KEY_PREFIX))
      .flatMap((key) => Option.toArray(decodeProfile(this.globalState.get(key))))
      .toSorted((left, right) => left.label.localeCompare(right.label));
  }

  profile(environmentId: string): BearerConnectionProfile | undefined {
    return Option.getOrUndefined(
      decodeProfile(this.globalState.get(PROFILE_KEY_PREFIX + environmentId)),
    );
  }

  saveProfile(profile: BearerConnectionProfile): Thenable<void> {
    return this.globalState.update(
      PROFILE_KEY_PREFIX + profile.environmentId,
      encodeProfile(profile),
    );
  }

  credential(environmentId: string): Thenable<string | undefined> {
    return this.secrets.get(CREDENTIAL_KEY_PREFIX + environmentId);
  }

  saveCredential(environmentId: string, token: string): Thenable<void> {
    return this.secrets.store(CREDENTIAL_KEY_PREFIX + environmentId, token);
  }

  removeCredential(environmentId: string): Thenable<void> {
    return this.secrets.delete(CREDENTIAL_KEY_PREFIX + environmentId);
  }

  async forget(environmentId: string): Promise<void> {
    await this.globalState.update(PROFILE_KEY_PREFIX + environmentId, undefined);
    await this.removeCredential(environmentId);
  }

  /** The environment whose credential a `SecretStorage` change event names, if any. */
  credentialEnvironment(secretKey: string): EnvironmentId | undefined {
    return secretKey.startsWith(CREDENTIAL_KEY_PREFIX)
      ? EnvironmentId.make(secretKey.slice(CREDENTIAL_KEY_PREFIX.length))
      : undefined;
  }
}

/**
 * The window's one environment, in `workspaceState`: VS Code has no per-window
 * state, and a workspace memento exists even in an empty window. A binding per
 * window is "one window per environment" in a form the code can check; a global
 * binding would give every window the same environment, and the workspace
 * folders alone cannot name one, since an empty window has none. Anton's
 * ruling.
 */
export class WindowBinding {
  private readonly workspaceState: Memento;

  constructor(workspaceState: Memento) {
    this.workspaceState = workspaceState;
  }

  get environmentId(): EnvironmentId | undefined {
    const value = this.workspaceState.get<unknown>(BINDING_KEY);
    return typeof value === "string" && value !== "" ? EnvironmentId.make(value) : undefined;
  }

  bind(environmentId: EnvironmentId): Thenable<void> {
    return this.workspaceState.update(BINDING_KEY, environmentId);
  }

  unbind(): Thenable<void> {
    return this.workspaceState.update(BINDING_KEY, undefined);
  }
}

/** An environment's saved route. The extension pairs one route per environment, named by its id. */
export function catalogTarget(profile: BearerConnectionProfile): BearerConnectionTarget {
  return new BearerConnectionTarget({
    environmentId: profile.environmentId,
    label: profile.label,
    connectionId: profile.connectionId,
  });
}

/**
 * The vendored registry's stores over the catalog and the binding. The registry
 * sees one environment at most, the bound one: registering it saves it to the
 * catalog and binds the window, removing it unbinds the window and leaves the
 * catalog to Forget. Routes the registry learns from a connected server live as
 * long as the window.
 */
export function catalogLayer(catalog: EnvironmentCatalog, binding: WindowBinding) {
  const learnedProfiles = new Map<string, ConnectionProfile>();

  const storage = <A>(evaluate: () => PromiseLike<A>) =>
    Effect.tryPromise({
      try: async () => evaluate(),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: `VS Code's storage failed: ${String(cause)}`,
        }),
    });
  const persistence = <A>(
    operation: ConnectionPersistenceError["operation"],
    evaluate: () => PromiseLike<A>,
  ) =>
    Effect.tryPromise({
      try: async () => evaluate(),
      catch: (cause) => new ConnectionPersistenceError({ operation, message: String(cause) }),
    });

  const profiles = ProfileStore.make({
    get: (connectionId) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(learnedProfiles.get(connectionId) ?? catalog.profile(connectionId)),
      ),
    put: (profile) =>
      isBearerProfile(profile) && profile.learned !== true
        ? storage(() => catalog.saveProfile(profile))
        : Effect.sync(() => void learnedProfiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void learnedProfiles.delete(connectionId)),
  });

  const credentials = CredentialStore.make({
    get: (connectionId) =>
      storage(() => catalog.credential(connectionId)).pipe(
        Effect.map((token) =>
          Option.map(
            Option.fromUndefinedOr(token),
            (token) => new BearerConnectionCredential({ token }),
          ),
        ),
      ),
    put: (connectionId, credential) =>
      storage(() => catalog.saveCredential(connectionId, credential.token)),
    remove: (connectionId) => storage(() => catalog.removeCredential(connectionId)),
  });

  const targets = Persistence.ConnectionTargetStore.of({
    list: Effect.sync(() => {
      const environmentId = binding.environmentId;
      const profile = environmentId === undefined ? undefined : catalog.profile(environmentId);
      return profile === undefined ? [] : [catalogTarget(profile)];
    }),
    listDisabled: Effect.succeed([]),
  });

  const registrations = Persistence.ConnectionRegistrationStore.of({
    register: (registration) =>
      registration._tag === "BearerConnectionRegistration"
        ? persistence("register-connection", async () => {
            await catalog.saveCredential(
              registration.target.environmentId,
              registration.credential.token,
            );
            await catalog.saveProfile(registration.profile);
            await binding.bind(registration.target.environmentId);
          })
        : Effect.fail(
            new ConnectionPersistenceError({
              operation: "register-connection",
              message: `The extension cannot save a ${registration._tag}.`,
            }),
          ),
    setRoutes: () => Effect.void,
    remove: (environmentId) =>
      persistence("remove-connection", async () => {
        if (binding.environmentId === environmentId) await binding.unbind();
      }),
    setEnabled: () => Effect.void,
  });

  return Layer.mergeAll(
    Layer.succeed(ProfileStore.ConnectionProfileStore, profiles),
    Layer.succeed(CredentialStore.ConnectionCredentialStore, credentials),
    Layer.succeed(Persistence.ConnectionTargetStore, targets),
    Layer.succeed(Persistence.ConnectionRegistrationStore, registrations),
    Layer.succeed(Persistence.EnvironmentCacheStore, noCache),
  );
}

/** The window keeps no offline copy of an environment: a reconnect reloads it. */
const noCache = Persistence.EnvironmentCacheStore.of({
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
});
