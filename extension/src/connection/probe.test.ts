import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthWebSocketTicketResult,
  EnvironmentAuthInvalidError,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it, vi } from "vite-plus/test";

import { probe, type ProbeError, type ProbeInput } from "./probe.ts";

const environmentId = EnvironmentId.make("environment-1");

interface Server {
  /** Answers only requests from these origins, like a dev server's CORS rules. */
  readonly allowedOrigin?: string;
  readonly reachable?: boolean;
  /** Refuses authenticated requests from any other origin, like a dev server's web port. */
  readonly refusesAuthenticated?: boolean;
  readonly protocolVersion?: number;
  readonly bearers?: ReadonlyArray<string>;
  readonly pairingCodes?: ReadonlyArray<string>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const authInvalid = () =>
  json(
    Schema.encodeSync(EnvironmentAuthInvalidError)(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "trace-1",
      }),
    ),
    401,
  );

/** A T3 Code server as a browser's fetch sees it, from `origin`. */
function fakeFetch(server: Server, origin: string, requests: Array<string>): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    requests.push(
      `${init?.method ?? "GET"} ${url.pathname}${init?.mode === "no-cors" ? " (no-cors)" : ""}`,
    );
    if (server.reachable === false) throw new TypeError("Failed to fetch");
    // An opaque response says nothing but that the server answered.
    if (init?.mode === "no-cors") return new Response(null);
    if (server.allowedOrigin !== undefined && server.allowedOrigin !== origin) {
      throw new TypeError("Failed to fetch");
    }
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (server.refusesAuthenticated === true && authorization !== undefined) {
      throw new TypeError("Failed to fetch");
    }
    switch (url.pathname) {
      case "/.well-known/t3/environment":
        return json(
          Schema.encodeSync(ExecutionEnvironmentDescriptor)({
            environmentId,
            label: "Studio",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0",
            orchestrationProtocolVersion: server.protocolVersion ?? ORCHESTRATION_PROTOCOL_VERSION,
            capabilities: { repositoryIdentity: false },
          }),
        );
      case "/api/auth/websocket-ticket":
        return (server.bearers ?? []).some((bearer) => authorization === `Bearer ${bearer}`)
          ? json(
              Schema.encodeSync(AuthWebSocketTicketResult)({
                ticket: "ticket-1",
                expiresAt: DateTime.makeUnsafe("2026-10-07T00:05:00Z"),
              }),
            )
          : authInvalid();
      case "/oauth/token": {
        const code = new URLSearchParams(String(init?.body)).get("subject_token");
        return code !== null && (server.pairingCodes ?? []).includes(code)
          ? json(
              Schema.encodeSync(AuthAccessTokenResult)({
                access_token: `bearer-for-${code}`,
                issued_token_type: AuthAccessTokenType,
                token_type: "Bearer",
                expires_in: 2_592_000,
                scope: "orchestration:read",
              }),
            )
          : authInvalid();
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  };
}

async function run(
  server: Server,
  input: Partial<ProbeInput> & { readonly credential?: string; readonly url?: string },
) {
  const origin = input.origin ?? "vscode-file://vscode-app";
  const httpBaseUrl = input.url ?? "http://localhost:3773/";
  const requests: Array<string> = [];
  const exit = await Effect.runPromiseExit(
    probe({
      target: {
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
        credential: input.credential ?? "bearer-1",
      },
      origin,
      ...(input.expectedEnvironmentId === undefined
        ? {}
        : { expectedEnvironmentId: input.expectedEnvironmentId }),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          Layer.succeed(ClientCapabilities.ClientPresentation, {
            metadata: { label: "Pult for VS Code" },
          }),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch(server, origin, requests)),
    ),
  );
  if (exit._tag === "Success") return { registration: exit.value, requests };
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (failure === undefined) throw new Error(`The probe died: ${String(exit.cause)}`);
  return { error: failure.error as ProbeError, requests };
}

describe("probe", () => {
  it("connects with a session token, never spending it as a pairing code", async () => {
    const { registration, requests } = await run({ bearers: ["bearer-1"] }, {});

    expect(registration?.target.environmentId).toBe(environmentId);
    expect(registration?.profile.label).toBe("Studio");
    expect(registration?.credential.token).toBe("bearer-1");
    expect(requests).not.toContain("POST /oauth/token");
  });

  it("redeems a token the server refuses as a bearer as a pairing code", async () => {
    const { registration } = await run(
      { bearers: ["bearer-for-ABCDEFGHJKLM"], pairingCodes: ["ABCDEFGHJKLM"] },
      { credential: "ABCDEFGHJKLM" },
    );

    expect(registration?.credential.token).toBe("bearer-for-ABCDEFGHJKLM");
  });

  it("names the token when the server takes it neither way", async () => {
    const { error } = await run({ bearers: ["bearer-1"] }, { credential: "spent-code" });

    expect(error?.kind).toBe("auth");
  });

  it("names this window's origin when a reachable server refuses it", async () => {
    const { error, requests } = await run({ allowedOrigin: "http://localhost:5733" }, {});

    expect(error?.kind).toBe("origin");
    expect(error?.detail).toContain("vscode-file://vscode-app");
    expect(error?.detail).toContain("T3CODE_DEV_ALLOWED_ORIGINS");
    expect(requests).toContain("GET / (no-cors)");
  });

  it("sends a dev server's web port, which refuses authenticated requests, to its server port", async () => {
    const { error } = await run({ bearers: ["bearer-1"], refusesAuthenticated: true }, {});

    expect(error?.kind).toBe("origin");
    expect(error?.detail).toContain("server port");
  });

  it("does not take a request that never left for a refused origin", async () => {
    // A web worker started from a blob: URL has a location that is no base URL.
    vi.stubGlobal("location", { origin: "http://host:3917", pathname: "http://host:3917/worker" });
    try {
      const { error } = await run({ bearers: ["bearer-1"] }, {});

      expect(error?.kind).toBe("failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tells an unreachable server from a refused origin", async () => {
    const { error } = await run({ reachable: false }, {});

    expect(error?.kind).toBe("unreachable");
  });

  it("refuses plain http from an https window before any request, except to loopback", async () => {
    const remote = await run(
      { bearers: ["bearer-1"] },
      { origin: "https://vscode.dev", url: "http://192.168.1.5:3773/" },
    );
    const loopback = await run(
      { bearers: ["bearer-1"] },
      { origin: "https://vscode.dev", url: "http://127.0.0.1:3773/" },
    );

    expect(remote.error?.kind).toBe("tls");
    expect(remote.requests).toEqual([]);
    expect(loopback.registration).toBeDefined();
  });

  it("refuses a server on another orchestration protocol", async () => {
    const { error } = await run(
      { bearers: ["bearer-1"], protocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 },
      {},
    );

    expect(error?.kind).toBe("incompatible");
  });

  it("refuses an address that now serves another environment", async () => {
    const { error, requests } = await run(
      { bearers: ["bearer-1"] },
      { expectedEnvironmentId: EnvironmentId.make("environment-2") },
    );

    expect(error?.kind).toBe("incompatible");
    expect(requests).toEqual(["GET /.well-known/t3/environment"]);
  });
});
