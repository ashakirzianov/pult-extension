import {
  bootstrapRemoteBearerSession,
  issueRemoteWebSocketTicket,
  type RemoteEnvironmentAuthError,
} from "@t3tools/client-runtime/authorization";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  mapRemoteEnvironmentError,
  orchestrationProtocolCompatibilityError,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ResolvedRemotePairingTarget } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClientError } from "effect/http";

import { catalogTarget } from "./catalog.ts";

export class ProbeError extends Schema.TaggedError<ProbeError>()("ProbeError", {
  /** What the user has to fix: the address, the server's allowed origins, TLS, the token, or the server. */
  kind: Schema.Literals(["unreachable", "origin", "tls", "auth", "incompatible", "failed"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface ProbeInput {
  readonly target: ResolvedRemotePairingTarget;
  /** The origin this extension host's requests carry, which a dev server must allow. */
  readonly origin: string;
  /** Set when reconnecting a catalog environment: the address must still serve it. */
  readonly expectedEnvironmentId?: EnvironmentId;
}

/**
 * The HTTP probe a connection waits for: the public descriptor names the
 * environment, then a WebSocket ticket proves the credential. The credential is
 * tried as a bearer first and, refused, redeemed as a pairing code, so the token
 * prompt takes either. HTTP, because a socket upgrade is never refused for its
 * origin and would hide the failure the extension most needs to explain.
 */
export const probe = Effect.fn("pult.probe")(function* (input: ProbeInput) {
  const { httpBaseUrl, wsBaseUrl, credential } = input.target;
  const host = new URL(httpBaseUrl).host;
  if (isMixedContent(input.origin, httpBaseUrl)) {
    return yield* new ProbeError({
      kind: "tls",
      detail: `This VS Code runs over https and cannot reach ${host} over plain http. Serve the environment over https, for example with \`t3 pair --tailscale\`.`,
    });
  }
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.catch((error) => explainFailure(error, input, "descriptor")),
  );
  if (
    input.expectedEnvironmentId !== undefined &&
    descriptor.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* new ProbeError({
      kind: "incompatible",
      detail: `${host} now serves ${descriptor.label}, a different environment.`,
    });
  }
  const incompatible = orchestrationProtocolCompatibilityError(descriptor);
  if (incompatible !== null) {
    return yield* new ProbeError({ kind: "incompatible", detail: incompatible.detail });
  }

  const presentation = yield* ClientCapabilities.ClientPresentation;
  const ticket = (bearerToken: string) =>
    issueRemoteWebSocketTicket({ httpBaseUrl, bearerToken }).pipe(Effect.as(bearerToken));
  const token = yield* ticket(credential).pipe(
    Effect.catchTag("EnvironmentAuthInvalidError", () =>
      bootstrapRemoteBearerSession({
        httpBaseUrl,
        credential,
        clientMetadata: presentation.metadata,
      }).pipe(
        Effect.flatMap((session) => ticket(session.access_token)),
        Effect.catchTags({
          EnvironmentAuthInvalidError: () => Effect.fail(refusedToken(descriptor.label)),
          EnvironmentRequestInvalidError: () => Effect.fail(refusedToken(descriptor.label)),
        }),
      ),
    ),
    Effect.catch((error) =>
      error instanceof ProbeError ? Effect.fail(error) : explainFailure(error, input, "credential"),
    ),
  );

  const profile = new BearerConnectionProfile({
    connectionId: descriptor.environmentId,
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    httpBaseUrl,
    wsBaseUrl,
  });
  return new BearerConnectionRegistration({
    target: catalogTarget(profile),
    profile,
    credential: new BearerConnectionCredential({ token }),
  });
});

function refusedToken(label: string) {
  return new ProbeError({
    kind: "auth",
    detail: `${label} accepted the token neither as a session nor as a pairing code. Mint a new one with \`t3 pair\` on that machine.`,
  });
}

const explainFailure = Effect.fn("pult.probe.explainFailure")(function* (
  error: RemoteEnvironmentAuthError,
  input: ProbeInput,
  stage: "descriptor" | "credential",
) {
  const { httpBaseUrl } = input.target;
  const host = new URL(httpBaseUrl).host;
  switch (error._tag) {
    case "RemoteEnvironmentAuthFetchError": {
      if (!isTransportError(error.cause)) {
        return yield* new ProbeError({ kind: "failed", detail: error.message });
      }
      // A browser hides why a request failed. A no-cors request reaches a live
      // server whatever its origin rules, so its answer tells the two apart.
      const fetch = yield* FetchHttpClient.Fetch;
      const answered = yield* Effect.tryPromise(() =>
        fetch(httpBaseUrl, { mode: "no-cors", signal: AbortSignal.timeout(5_000) }),
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!answered) {
        return yield* new ProbeError({ kind: "unreachable", detail: `Could not reach ${host}.` });
      }
      return yield* new ProbeError({
        kind: "origin",
        detail:
          stage === "descriptor"
            ? `${host} refuses requests from this window's origin, ${input.origin}. A dev server allows another origin only when T3CODE_DEV_ALLOWED_ORIGINS names it.`
            : `${host} answers, but refuses authenticated requests from this window's origin, ${input.origin}. A dev server allows another origin only when T3CODE_DEV_ALLOWED_ORIGINS names it, and its web port allows only localhost origins: pair with its server port.`,
      });
    }
    case "RemoteEnvironmentAuthTimeoutError":
      return yield* new ProbeError({
        kind: "unreachable",
        detail: `${host} did not answer in time.`,
      });
    case "RemoteEnvironmentAuthInvalidJsonError":
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return yield* new ProbeError({
        kind: "incompatible",
        detail: `${host} answered, but not as a T3 Code server.`,
      });
    case "EnvironmentAuthInvalidError":
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return yield* new ProbeError({
        kind: "auth",
        detail: mapRemoteEnvironmentError(error).detail,
      });
    case "EnvironmentRequestInvalidError":
    case "EnvironmentResourceNotFoundError":
    case "EnvironmentInternalError":
      return yield* new ProbeError({
        kind: "incompatible",
        detail: mapRemoteEnvironmentError(error).detail,
      });
  }
});

function isTransportError(cause: unknown): boolean {
  return HttpClientError.isHttpClientError(cause) && cause.reason._tag === "TransportError";
}

/** An https page may not open plain http, except to this machine's loopback. */
export function isMixedContent(origin: string, httpBaseUrl: string): boolean {
  if (!origin.startsWith("https:")) return false;
  const url = new URL(httpBaseUrl);
  return url.protocol === "http:" && !isLoopback(url.hostname);
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}
