import type * as Socket from "effect/socket/Socket";
import * as vscode from "vscode";

import { SocketMux } from "./socketMux.ts";

type EventType = "open" | "message" | "error" | "close";
type Listener = (event: Socket.WebSocketEvent) => void;

/**
 * A real socket as the host's runtime sees it: the server's frames, less those
 * addressed to webviews, which its multiplexer routes to them.
 */
/** A socket the hub can tap: a browser WebSocket, or the shell's (`../connection/shell.ts`). */
type TappableSocket = Socket.WebSocketLike & { binaryType: BinaryType };

class TappedWebSocket implements Socket.WebSocketLike {
  readonly mux: SocketMux;
  private readonly socket: TappableSocket;
  private readonly listeners = new Map<EventType, Map<Listener, boolean>>();

  constructor(socket: TappableSocket, hub: SocketHub) {
    this.socket = socket;
    this.mux = new SocketMux((frame) => socket.send(frame));
    socket.addEventListener("open", (event) => {
      hub.opened(this);
      this.dispatch("open", event);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return this.dispatch("message", event);
      const own = this.mux.fromServer(event.data);
      if (own === undefined) return;
      this.dispatch("message", own === event.data ? event : { type: "message", data: own });
    });
    socket.addEventListener("error", (event) => this.dispatch("error", event));
    socket.addEventListener("close", (event) => {
      hub.closed(this);
      this.dispatch("close", event);
    });
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  get binaryType(): BinaryType {
    return this.socket.binaryType;
  }

  set binaryType(type: BinaryType) {
    this.socket.binaryType = type;
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
    this.socket.send(data);
  }

  close(code?: number, reason?: string) {
    this.socket.close(code, reason);
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

/** What a webview's socket hears: what a WebSocket's events would say. */
export interface VirtualSocketEvents {
  readonly opened: () => void;
  readonly message: (data: string) => void;
  readonly closed: (code: number, reason: string) => void;
}

export interface VirtualSocket {
  send(data: string): void;
  close(): void;
}

interface Client {
  readonly events: VirtualSocketEvents;
  socket: TappedWebSocket | undefined;
}

/**
 * The window's one socket to its environment, shared with the webviews of its
 * thread tabs. The host's runtime dials through `webSocketConstructor`; a
 * webview's socket attaches to whichever real socket is open, waits for the
 * next one otherwise, and closes with it.
 */
export class SocketHub implements vscode.Disposable {
  private current: TappedWebSocket | undefined;
  private readonly clients = new Map<number, Client>();
  private nextClientId = 1;
  private readonly opens = new vscode.EventEmitter<void>();
  /** A real socket opened: webviews waiting to reconnect may retry now. */
  readonly onDidOpen = this.opens.event;

  /** Dials the real socket: a browser WebSocket, or in Pult the shell's. */
  private readonly dial: (url: string, protocols?: string | Array<string>) => TappableSocket;

  constructor(
    dial: (url: string, protocols?: string | Array<string>) => TappableSocket = (url, protocols) =>
      new WebSocket(url, protocols),
  ) {
    this.dial = dial;
  }

  readonly webSocketConstructor = (url: string, options?: Socket.WebSocketConstructorOptions) => {
    if (typeof options === "object" && !Array.isArray(options)) {
      throw new Error("A browser WebSocket cannot set handshake headers.");
    }
    return new TappedWebSocket(this.dial(url, options), this);
  };

  open(events: VirtualSocketEvents): VirtualSocket {
    const clientId = this.nextClientId++;
    const client: Client = { events, socket: undefined };
    this.clients.set(clientId, client);
    if (this.current !== undefined) this.attach(clientId, client, this.current);
    return {
      send: (data) => client.socket?.mux.fromClient(clientId, data),
      close: () => {
        client.socket?.mux.detach(clientId);
        this.clients.delete(clientId);
      },
    };
  }

  /** @internal */
  opened(socket: TappedWebSocket) {
    this.current = socket;
    for (const [clientId, client] of this.clients) {
      if (client.socket === undefined) this.attach(clientId, client, socket);
    }
    this.opens.fire();
  }

  /** @internal */
  closed(socket: TappedWebSocket) {
    if (this.current === socket) this.current = undefined;
    for (const [clientId, client] of this.clients) {
      if (client.socket !== socket) continue;
      this.clients.delete(clientId);
      client.events.closed(1006, "The extension host's connection closed.");
    }
  }

  private attach(clientId: number, client: Client, socket: TappedWebSocket) {
    client.socket = socket;
    socket.mux.attach(clientId, client.events.message);
    client.events.opened();
  }

  dispose() {
    for (const client of this.clients.values()) {
      client.events.closed(1001, "The extension host is shutting down.");
    }
    this.clients.clear();
    this.opens.dispose();
  }
}
