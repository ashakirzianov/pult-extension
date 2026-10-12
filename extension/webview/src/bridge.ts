// The webview's side of the host bridge (`../../src/threads/protocol.ts`): the
// one `acquireVsCodeApi` handle, host messages, and the socket and fetch that
// travel over them.
import type * as Socket from "effect/socket/Socket";

import type { HostMessage, WebviewMessage } from "../../src/threads/protocol.ts";

interface VsCodeApi {
  postMessage(message: unknown, transfer?: ReadonlyArray<Transferable>): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** VS Code hands the API out once per page. */
export const vscodeApi = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  // VS Code's postMessage, to the host, which takes no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  vscodeApi.postMessage(message);
}

const hostListeners = new Set<(message: HostMessage) => void>();
window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  for (const listener of hostListeners) listener(event.data);
});

export function onHostMessage(listener: (message: HostMessage) => void): () => void {
  hostListeners.add(listener);
  return () => hostListeners.delete(listener);
}

export function nextHostMessage<T extends HostMessage["type"]>(
  type: T,
): Promise<Extract<HostMessage, { type: T }>> {
  return new Promise((resolve) => {
    const stop = onHostMessage((message) => {
      if (message.type !== type) return;
      stop();
      resolve(message as Extract<HostMessage, { type: T }>);
    });
  });
}

type SocketEventType = "open" | "message" | "error" | "close";
type SocketListener = (event: Socket.WebSocketEvent) => void;

const sockets = new Map<number, BridgedWebSocket>();
let nextSocketId = 1;

/**
 * A WebSocket the host opens on the webview's behalf: the vendored runtime's
 * `Socket.WebSocketConstructor`. The host attaches it to its own connection to
 * the environment, so the URL, which names the server, goes unused.
 */
export class BridgedWebSocket implements Socket.WebSocketLike {
  readyState = 0;
  private readonly id = nextSocketId++;
  private readonly listeners = new Map<SocketEventType, Map<SocketListener, boolean>>();

  constructor() {
    sockets.set(this.id, this);
    post({ type: "socket.open", socketId: this.id });
  }

  addEventListener(
    type: SocketEventType,
    listener: SocketListener,
    options?: { readonly once?: boolean },
  ): void {
    let byType = this.listeners.get(type);
    if (byType === undefined) this.listeners.set(type, (byType = new Map()));
    byType.set(listener, options?.once === true);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.readyState !== 1) return;
    post({
      type: "socket.send",
      socketId: this.id,
      data: typeof data === "string" ? data : new TextDecoder().decode(data),
    });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    post({ type: "socket.close", socketId: this.id });
    this.closed(code, reason);
  }

  /** @internal Host messages for this socket. */
  receive(message: HostMessage): void {
    switch (message.type) {
      case "socket.opened":
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.dispatch("open", { type: "open" });
        return;
      case "socket.message":
        if (this.readyState === 1)
          this.dispatch("message", { type: "message", data: message.data });
        return;
      case "socket.closed":
        this.closed(message.code, message.reason);
        return;
    }
  }

  private closed(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    sockets.delete(this.id);
    this.dispatch("close", { type: "close", code, reason });
  }

  private dispatch(type: SocketEventType, event: Socket.WebSocketEvent): void {
    const byType = this.listeners.get(type);
    if (byType === undefined) return;
    for (const [listener, once] of byType) {
      if (once) byType.delete(listener);
      listener(event);
    }
  }
}

onHostMessage((message) => {
  if (
    message.type === "socket.opened" ||
    message.type === "socket.message" ||
    message.type === "socket.closed"
  ) {
    sockets.get(message.socketId)?.receive(message);
  }
});

interface PendingFetch {
  readonly resolve: (response: Response) => void;
  readonly reject: (error: unknown) => void;
}

const fetches = new Map<number, PendingFetch>();
let nextRequestId = 1;

onHostMessage((message) => {
  if (message.type !== "fetch.response" && message.type !== "fetch.failed") return;
  const pending = fetches.get(message.requestId);
  if (pending === undefined) return;
  fetches.delete(message.requestId);
  if (message.type === "fetch.failed") {
    pending.reject(new TypeError(message.message));
    return;
  }
  const empty = message.status === 204 || message.status === 205 || message.status === 304;
  pending.resolve(
    new Response(empty ? null : message.body, {
      status: message.status,
      statusText: message.statusText,
      headers: message.headers.map(([name, value]) => [name, value]),
    }),
  );
});

/**
 * Routes `fetch` to the environment's origin through the host, whose origin a
 * server admits, where a webview's origin changes per webview; everything else,
 * such as the bundle's own assets, goes to the webview's fetch.
 */
export function installBridgedFetch(environmentOrigin: string): void {
  const webviewFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== environmentOrigin) return webviewFetch(input, init);
    const signal = request.signal;
    signal.throwIfAborted();
    const body =
      request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    const requestId = nextRequestId++;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        fetches.delete(requestId);
        post({ type: "fetch.abort", requestId });
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      fetches.set(requestId, {
        resolve: (response) => {
          signal.removeEventListener("abort", onAbort);
          resolve(response);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      post({
        type: "fetch",
        requestId,
        url: request.url,
        method: request.method,
        headers: [...request.headers],
        body,
      });
    });
  };
}
