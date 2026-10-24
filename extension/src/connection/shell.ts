import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import type * as Socket from "effect/socket/Socket";
import * as vscode from "vscode";

import { catalogTarget } from "./catalog.ts";

/**
 * Pult's own shell names itself so (`pult` repo, `src/main.ts`). There the
 * page owns the one connection to the environment, and the extension uses it
 * instead of connecting on its own.
 */
export const IN_PULT_SHELL = vscode.env.appName === "Pult";

/** The page's environment as the shell reports it (`pult` repo, `src/connection/connection.ts`). */
export interface ShellEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly phase: string;
  readonly error: string | null;
}

/**
 * What the shell tells the extension, in order (`pult` repo,
 * `src/connection/bridge.ts`). Any extension can run `pult.shellEvents`, so an
 * environment event only says to read the environment from the shell again.
 */
type ShellEvent =
  | { readonly type: "environment" }
  | { readonly type: "socket.opened"; readonly socketId: string }
  | { readonly type: "socket.message"; readonly socketId: string; readonly data: string }
  | {
      readonly type: "socket.closed";
      readonly socketId: string;
      readonly code: number;
      readonly reason: string;
    };

interface BridgedResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
}

/**
 * The bearer the extension's runtime holds in the shell: a stand-in, which the
 * shell replaces with the real one on every request it sends for the
 * extension. The real bearer never leaves the page.
 */
const SHELL_BEARER = "pult-shell";

type EventType = "open" | "message" | "error" | "close";
type Listener = (event: Socket.WebSocketEvent) => void;

/**
 * A WebSocket the shell multiplexes onto the page's one socket: the vendored
 * runtime's `Socket.WebSocketConstructor` in Pult. The URL, which names the
 * server and carries a ticket, goes unused: the page's socket is already
 * authenticated.
 */
class ShellWebSocket implements Socket.WebSocketLike {
  readyState = 0;
  binaryType: BinaryType = "blob";
  readonly id = crypto.randomUUID();
  private readonly listeners = new Map<EventType, Map<Listener, boolean>>();
  private readonly client: ShellConnectionClient;

  constructor(client: ShellConnectionClient) {
    this.client = client;
    client.sockets.set(this.id, this);
    vscode.commands.executeCommand("pult-shell.socket.open", this.id).then(undefined, (error) => {
      this.closed(1011, `The shell refused the socket: ${String(error)}`);
    });
  }

  addEventListener(type: EventType, listener: Listener, options?: { readonly once?: boolean }) {
    let byType = this.listeners.get(type);
    if (byType === undefined) this.listeners.set(type, (byType = new Map()));
    byType.set(listener, options?.once === true);
  }

  removeEventListener(type: EventType, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    if (this.readyState !== 1) return;
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    void vscode.commands.executeCommand("pult-shell.socket.send", this.id, text);
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    void vscode.commands.executeCommand("pult-shell.socket.close", this.id);
    this.closed(code, reason);
  }

  /** @internal */
  receive(event: Exclude<ShellEvent, { type: "environment" }>) {
    switch (event.type) {
      case "socket.opened":
        if (this.readyState !== 0) return;
        this.readyState = 1;
        return this.dispatch("open", { type: "open" });
      case "socket.message":
        if (this.readyState === 1) this.dispatch("message", { type: "message", data: event.data });
        return;
      case "socket.closed":
        return this.closed(event.code, event.reason);
    }
  }

  private closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.client.sockets.delete(this.id);
    this.dispatch("close", { type: "close", code, reason });
  }

  private dispatch(type: EventType, event: Socket.WebSocketEvent) {
    const byType = this.listeners.get(type);
    if (byType === undefined) return;
    for (const [listener, once] of byType) {
      if (once) byType.delete(listener);
      listener(event);
    }
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/**
 * The extension's side of the shell's connection (`pult` repo,
 * `src/connection/bridge.ts`): the page's environment as it changes, sockets
 * onto the page's socket, and `fetch`, which sends requests to the environment
 * through the shell. `WindowConnection` runs its runtime over these in Pult.
 */
export class ShellConnectionClient implements vscode.Disposable {
  /** @internal */
  readonly sockets = new Map<string, ShellWebSocket>();
  private current: ShellEnvironment | null = null;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly command: vscode.Disposable;
  private reads = Promise.resolve();

  private constructor() {
    this.command = vscode.commands.registerCommand(
      "pult.shellEvents",
      (events: ReadonlyArray<ShellEvent>) => {
        for (const event of events) {
          if (event.type === "environment") this.read();
          else this.sockets.get(event.socketId)?.receive(event);
        }
      },
    );
  }

  /** Reads the environment from the shell, one read after another, so the last answer stands. */
  private read() {
    this.reads = this.reads
      .then(async () => {
        this.current =
          (await vscode.commands.executeCommand<ShellEnvironment | null>(
            "pult-shell.environment",
          )) ?? null;
        this.changes.fire();
      })
      .catch((error: unknown) =>
        console.warn("[pult] reading the shell's environment failed", error),
      );
  }

  /**
   * Subscribes to the shell's environment, which it answers as it stands. The
   * shell closes the sockets an earlier instance of the extension left open.
   */
  static async start(): Promise<ShellConnectionClient> {
    const client = new ShellConnectionClient();
    client.current =
      (await vscode.commands.executeCommand<ShellEnvironment | null>("pult-shell.connection")) ??
      null;
    return client;
  }

  get environment(): ShellEnvironment | null {
    return this.current;
  }

  /** The environment as the vendored registry takes it, with the stand-in bearer. */
  registration(environment: ShellEnvironment): BearerConnectionRegistration {
    const environmentId = EnvironmentId.make(environment.environmentId);
    const profile = new BearerConnectionProfile({
      connectionId: environmentId,
      environmentId,
      label: environment.label,
      httpBaseUrl: environment.httpBaseUrl,
      wsBaseUrl: environment.wsBaseUrl,
    });
    return new BearerConnectionRegistration({
      target: catalogTarget(profile),
      profile,
      credential: new BearerConnectionCredential({ token: SHELL_BEARER }),
    });
  }

  readonly webSocketConstructor = () => new ShellWebSocket(this);

  /** `fetch`, with requests to the environment's origin sent by the shell, which adds the bearer. */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const environment = this.current;
    if (
      environment === null ||
      new URL(request.url).origin !== new URL(environment.httpBaseUrl).origin
    ) {
      return globalThis.fetch(request);
    }
    request.signal.throwIfAborted();
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? null
        : toBase64(new Uint8Array(await request.arrayBuffer()));
    const response = await vscode.commands.executeCommand<BridgedResponse>("pult-shell.fetch", {
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body,
    });
    const empty = response.status === 204 || response.status === 205 || response.status === 304;
    return new Response(empty ? null : fromBase64(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers.map(([name, value]) => [name, value]),
    });
  };

  dispose() {
    for (const socket of this.sockets.values()) socket.close(1001, "The extension stopped.");
    this.command.dispose();
    this.changes.dispose();
  }
}

/**
 * In Pult, the catalog the window connection writes to lives in memory: the
 * shell keeps the environment and its bearer, and the extension holds only
 * what the shell reports, never environments of its own.
 */
export function memoryCatalogStorage() {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  return {
    globalState: {
      keys: () => [...state.keys()],
      get: <T>(key: string, fallback?: T) => (state.has(key) ? (state.get(key) as T) : fallback),
      update: async (key: string, value: unknown) => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
      },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
  };
}

/**
 * Keeps the window connection on the shell's environment: connected to it,
 * with the stand-in bearer, while the page is, and disconnected when the page
 * disconnects. The shell reconnects the page after a reload; this follows.
 * It acts on the environment it last asked for, starting from the window's
 * binding, which the registry connects at activation: the connection's own
 * state lags behind, and registering an environment twice restarts its
 * connection midway. The window's socket rides on the page's, so when the
 * page's connection becomes ready a window connection still waiting between
 * attempts retries at once.
 */
export function followShell(
  shell: ShellConnectionClient,
  connection: {
    readonly environment: { readonly phase: string } | null;
    connect(registration: BearerConnectionRegistration): Promise<void>;
    disconnect(): Promise<void>;
    retryNow(): Promise<void>;
  },
  bound: string | undefined,
): vscode.Disposable {
  let queue = Promise.resolve();
  let requested = bound;
  let shellPhase: string | undefined;
  const sync = () => {
    queue = queue
      .then(async () => {
        const next = shell.environment;
        const becameReady = next?.phase === "ready" && shellPhase !== "ready";
        shellPhase = next?.phase;
        if (next === null) {
          if (requested === undefined) return;
          requested = undefined;
          await connection.disconnect();
        } else if (requested !== next.environmentId) {
          requested = next.environmentId;
          await connection.connect(shell.registration(next));
        } else if (becameReady && connection.environment?.phase !== "ready") {
          await connection.retryNow();
        }
      })
      .catch((error: unknown) => {
        console.warn("[pult] following the shell's connection failed", error);
      });
  };
  sync();
  return shell.onDidChange(sync);
}
