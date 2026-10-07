import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  CredentialStore,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { catalogLayer, catalogTarget, EnvironmentCatalog, WindowBinding } from "./catalog.ts";

function memento() {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

function secretStorage() {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
  };
}

/** One VS Code: a catalog shared by its windows, each with its own binding. */
function vscodeProfile() {
  const catalog = new EnvironmentCatalog(memento(), secretStorage());
  const window = () => {
    const binding = new WindowBinding(memento());
    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | Persistence.ConnectionRegistrationStore
        | Persistence.ConnectionTargetStore
        | ProfileStore.ConnectionProfileStore
        | CredentialStore.ConnectionCredentialStore
      >,
    ) => Effect.runPromise(Effect.provide(effect, catalogLayer(catalog, binding)));
    return { binding, run };
  };
  return { catalog, window };
}

const environmentId = EnvironmentId.make("environment-1");
const profile = new BearerConnectionProfile({
  connectionId: environmentId,
  environmentId,
  label: "Studio",
  httpBaseUrl: "http://localhost:3773/",
  wsBaseUrl: "ws://localhost:3773/",
});
const registration = new BearerConnectionRegistration({
  target: catalogTarget(profile),
  profile,
  credential: new BearerConnectionCredential({ token: "bearer-1" }),
});

const register = Persistence.ConnectionRegistrationStore.use((store) =>
  store.register(registration, [registration.target]),
);
const listTargets = Persistence.ConnectionTargetStore.use((store) => store.list);
const readCredential = CredentialStore.ConnectionCredentialStore.use((store) =>
  store.get(environmentId),
);

describe("the environment catalog", () => {
  it("saves a registered environment for every window and binds only the registering one", async () => {
    const { catalog, window } = vscodeProfile();
    const first = window();
    const second = window();

    await first.run(register);

    expect(catalog.list()).toEqual([profile]);
    expect(await catalog.credential(environmentId)).toBe("bearer-1");
    expect(first.binding.environmentId).toBe(environmentId);
    expect(await first.run(listTargets)).toEqual([registration.target]);
    expect(second.binding.environmentId).toBeUndefined();
    expect(await second.run(listTargets)).toEqual([]);
    expect(await second.run(readCredential)).toEqual(
      Option.some(new BearerConnectionCredential({ token: "bearer-1" })),
    );
  });

  it("unbinds a removed environment from its window and keeps it in the catalog", async () => {
    const { catalog, window } = vscodeProfile();
    const first = window();
    const second = window();
    await first.run(register);
    await second.binding.bind(environmentId);

    await first.run(
      Persistence.ConnectionRegistrationStore.use((store) => store.remove(environmentId)),
    );

    expect(first.binding.environmentId).toBeUndefined();
    expect(second.binding.environmentId).toBe(environmentId);
    expect(catalog.profile(environmentId)).toEqual(profile);
    expect(await catalog.credential(environmentId)).toBe("bearer-1");
  });

  it("forgets the profile and the credential together", async () => {
    const { catalog, window } = vscodeProfile();
    const first = window();
    await first.run(register);

    await catalog.forget(environmentId);

    expect(catalog.list()).toEqual([]);
    expect(await first.run(readCredential)).toEqual(Option.none());
  });

  it("keeps a route the server reported for the window without saving it", async () => {
    const { catalog, window } = vscodeProfile();
    const first = window();
    await first.run(register);
    const learned = new BearerConnectionProfile({
      ...profile,
      connectionId: `learned:http://192.168.1.5:3773@${environmentId}`,
      httpBaseUrl: "http://192.168.1.5:3773/",
      wsBaseUrl: "ws://192.168.1.5:3773/",
      learned: true,
    });

    const read = await first.run(
      ProfileStore.ConnectionProfileStore.use((store) =>
        store.put(learned).pipe(Effect.andThen(store.get(learned.connectionId))),
      ),
    );

    expect(read).toEqual(Option.some(learned));
    expect(catalog.list()).toEqual([profile]);
  });

  it("skips catalog entries it cannot read", async () => {
    const globalState = memento();
    await globalState.update("pult.environment/broken", { label: "No address" });
    const catalog = new EnvironmentCatalog(globalState, secretStorage());

    expect(catalog.list()).toEqual([]);
  });
});
