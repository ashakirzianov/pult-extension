// Stands in for the copy's `src/connection/runtime.ts` in the shell's build
// (`../stubs.ts`): the thread view's state runtime over the connection Pult's
// shell owns. The shell's runtime (the `pult` repo's `src/connection/`) is the
// vendored connection over the page's platform and its one socket; this adds
// what the app around the view brings (the snapshot loaders, background
// activity reports, request latencies and the browser's Crypto), so the view
// and the shell share one registry, one supervisor and one socket.
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import * as Dpop from "../t3/src/cloud/dpop";
import type * as Upstream from "../t3/src/connection/runtime";
import * as BackgroundActivityReporter from "../t3/src/lib/backgroundActivityReporter";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../t3/src/rpc/requestLatencyState";
import { threadViewHostStarted } from "./host.ts";

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

const layerSnapshotLoader = Layer.mergeAll(
  BoundedThreadSnapshotLoader.layer,
  ShellSnapshotLoader.layer,
  ThreadHistoryController.layer,
  PullRequestDiffLoader.layer,
);

type UpstreamServices =
  typeof Upstream.connectionAtomRuntime extends Atom.AtomRuntime<infer R, infer _E> ? R : never;

const layerApp = BackgroundActivityReporter.layer.pipe(
  Layer.provideMerge(layerSnapshotLoader),
  Layer.provideMerge(
    Layer.mergeAll(
      BackgroundActivityReporter.layerObserver,
      layerRpcRequestObserver,
      // The browser's Crypto, which upstream's app provides with its DPoP keys.
      Dpop.layer,
    ),
  ),
);

/** What the shell's connection runtime must hold: everything upstream's runtime does, less what this file adds. */
export type ShellConnectionServices = Exclude<UpstreamServices, Layer.Success<typeof layerApp>>;

// Waits for the shell to start the view: the view's modules build this runtime as they load.
const layerShell = Layer.effectContext(
  Effect.promise(() => threadViewHostStarted().then((host) => host.connection())),
);

export const connectionAtomRuntime: typeof Upstream.connectionAtomRuntime = Atom.runtime(
  layerApp.pipe(Layer.provideMerge(layerShell)),
);
