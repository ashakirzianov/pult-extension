// Stands in for the copy's `src/connection/runtime.ts` (`../stubs.ts`): the same
// composition of the vendored runtime, over this page's platform and a socket
// the host bridges. One instance per webview, since the state atoms assume one
// runtime per page.
import { Connection } from "@t3tools/client-runtime/connection";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";
import * as Socket from "effect/socket/Socket";

import * as Dpop from "../t3/src/cloud/dpop";
import * as ManagedRelayLayer from "../t3/src/cloud/managedRelayLayer";
import { resolveRelayTracingConfig } from "../t3/src/cloud/publicConfig";
import type * as Upstream from "../t3/src/connection/runtime";
import * as BackgroundActivityReporter from "../t3/src/lib/backgroundActivityReporter";
import * as ClientTracer from "../t3/src/observability/clientTracer";
import { BridgedWebSocket } from "./bridge.ts";
import { platformLayer } from "./platform.ts";

// `fetch` itself routes the environment's origin through the host (`bridge.ts`).
const layerHttpClient = layerRemoteHttpClient((input, init) => globalThis.fetch(input, init));

const layerRuntime = Layer.mergeAll(
  layerHttpClient,
  Dpop.layer,
  Layer.succeed(Socket.WebSocketConstructor, () => new BridgedWebSocket()),
  ClientTracer.layer,
  RelayTracing.layer(resolveRelayTracingConfig(), {
    serviceName: "pult-extension-thread",
    serviceVersion: import.meta.env.APP_VERSION,
    runtime: "browser",
    client: "web",
  }).pipe(Layer.provide(layerHttpClient)),
  ManagedRelayLayer.layer("http://relay.invalid").pipe(
    Layer.provide(Layer.mergeAll(layerHttpClient, Dpop.layer)),
  ),
);

const layerSnapshotLoader = Layer.mergeAll(
  BoundedThreadSnapshotLoader.layer,
  ShellSnapshotLoader.layer,
  ThreadHistoryController.layer,
  PullRequestDiffLoader.layer,
);

const layerConnection = BackgroundActivityReporter.layer.pipe(
  Layer.provideMerge(
    layerSnapshotLoader.pipe(
      Layer.provideMerge(
        Connection.layerWithOptions({
          environmentThemes: true,
          usageLimitSources: true,
          usageLimitsCommand: true,
        }),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          layerRuntime,
          platformLayer.pipe(Layer.provide(layerRuntime)),
          BackgroundActivityReporter.layerObserver,
        ),
      ),
    ),
  ),
);

export const connectionAtomRuntime: typeof Upstream.connectionAtomRuntime =
  Atom.runtime(layerConnection);
