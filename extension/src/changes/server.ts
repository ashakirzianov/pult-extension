import {
  type EnvironmentRpcInput,
  type EnvironmentUnaryRpcTag,
  request,
} from "@t3tools/client-runtime/rpc";
import {
  type ClientGuardedRpcTag,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  WS_METHODS,
} from "@t3tools/contracts";

import type { WindowBinding } from "../connection/catalog.ts";
import type { WindowConnection } from "../connection/service.ts";
import { whenReady } from "../workspace/server.ts";

/** The server's review calls the changes view uses: a project's diff sources with their files, and a file's two sides. */
export interface ChangesServer {
  readonly diffPreview: (input: ReviewDiffPreviewInput) => Promise<ReviewDiffPreviewResult>;
  readonly diffFileContents: (
    input: ReviewDiffFileContentsInput,
  ) => Promise<ReviewDiffFileContentsResult>;
}

/** The window's connection as the changes view's server, waiting for a connecting window as the workspace's does. */
export function changesServer(connection: WindowConnection, binding: WindowBinding): ChangesServer {
  const call = async <Tag extends Exclude<EnvironmentUnaryRpcTag, ClientGuardedRpcTag>>(
    tag: Tag,
    input: EnvironmentRpcInput<Tag>,
  ) => {
    await whenReady(connection, binding);
    return connection.run(request(tag, input));
  };
  return {
    diffPreview: (input) => call(WS_METHODS.reviewGetDiffPreview, input),
    diffFileContents: (input) => call(WS_METHODS.reviewGetDiffFileContents, input),
  };
}
