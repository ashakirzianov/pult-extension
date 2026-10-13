// Webview clients on the host's one socket (`pult/decisions`, `connection-owner`).
// The socket speaks Effect RPC in JSON, one message or an array of them per
// frame. A client's messages go upstream with their request ids rewritten into
// a namespace of the client's own, a string the host's runtime, whose ids are
// numbers, never uses; the server echoes ids back unchanged, so a response
// routes by its id and returns to its client with the id the client sent.

type RequestId = string | number;

interface WireMessage {
  readonly _tag: string;
  readonly id?: RequestId;
  readonly requestId?: RequestId;
}

const ID_PREFIX = "pult:";

function clientRequestId(clientId: number, id: RequestId): string {
  return `${ID_PREFIX}${clientId}:${typeof id === "number" ? "n" : "s"}:${id}`;
}

/** The client and its own id behind a rewritten id, or null for the host's ids. */
export function parseClientRequestId(
  id: RequestId,
): { readonly clientId: number; readonly id: RequestId } | null {
  if (typeof id !== "string" || !id.startsWith(ID_PREFIX)) return null;
  const match = /^pult:(\d+):([ns]):(.*)$/s.exec(id);
  if (match === null) return null;
  return {
    clientId: Number(match[1]),
    id: match[2] === "n" ? Number(match[3]) : match[3]!,
  };
}

function decodeFrame(frame: string): ReadonlyArray<WireMessage> | null {
  try {
    const decoded: unknown = JSON.parse(frame);
    const messages = Array.isArray(decoded) ? decoded : [decoded];
    return messages.every(
      (message): message is WireMessage =>
        typeof message === "object" && message !== null && typeof message._tag === "string",
    )
      ? messages
      : null;
  } catch {
    return null;
  }
}

function encodeFrame(messages: ReadonlyArray<WireMessage>): string {
  return JSON.stringify(messages.length === 1 ? messages[0] : messages);
}

/**
 * The routing of one upstream socket. `write` sends a frame on the socket;
 * `deliver` hands a frame to an attached client.
 */
export class SocketMux {
  private readonly write: (frame: string) => void;
  private readonly clients = new Map<
    number,
    { readonly deliver: (frame: string) => void; readonly pending: Set<string> }
  >();

  constructor(write: (frame: string) => void) {
    this.write = write;
  }

  attach(clientId: number, deliver: (frame: string) => void): void {
    this.clients.set(clientId, { deliver, pending: new Set() });
  }

  /** Detaches a client and interrupts what it left running, its subscriptions included. */
  detach(clientId: number): void {
    const client = this.clients.get(clientId);
    if (client === undefined) return;
    this.clients.delete(clientId);
    if (client.pending.size === 0) return;
    this.write(
      encodeFrame([...client.pending].map((requestId) => ({ _tag: "Interrupt", requestId }))),
    );
  }

  /** A frame from a client, rewritten and sent upstream; a ping is answered here. */
  fromClient(clientId: number, frame: string): void {
    const client = this.clients.get(clientId);
    const messages = decodeFrame(frame);
    if (client === undefined || messages === null) return;
    const upstream: Array<WireMessage> = [];
    for (const message of messages) {
      switch (message._tag) {
        case "Ping":
          // The host's own pings watch the socket; a client's watch the bridge.
          client.deliver(JSON.stringify({ _tag: "Pong" }));
          break;
        case "Eof":
          // The socket outlives any one client.
          break;
        case "Request": {
          if (message.id === undefined) break;
          const id = clientRequestId(clientId, message.id);
          client.pending.add(id);
          upstream.push({ ...message, id });
          break;
        }
        default:
          upstream.push(
            message.requestId === undefined
              ? message
              : { ...message, requestId: clientRequestId(clientId, message.requestId) },
          );
      }
    }
    if (upstream.length > 0) this.write(encodeFrame(upstream));
  }

  /**
   * A frame from the server: clients' messages go to them, and the host's
   * share is returned for its own runtime, the frame itself when all of it is
   * the host's, undefined when none is.
   */
  fromServer(frame: string): string | undefined {
    if (this.clients.size === 0) return frame;
    const messages = decodeFrame(frame);
    if (messages === null) return frame;
    const host: Array<WireMessage> = [];
    const byClient = new Map<number, Array<WireMessage>>();
    const toClient = (clientId: number, message: WireMessage) => {
      let list = byClient.get(clientId);
      if (list === undefined) byClient.set(clientId, (list = []));
      list.push(message);
    };
    for (const message of messages) {
      const owner =
        message.requestId === undefined ? null : parseClientRequestId(message.requestId);
      if (owner !== null) {
        const client = this.clients.get(owner.clientId);
        if (client === undefined) continue;
        if (message._tag === "Exit") client.pending.delete(String(message.requestId));
        toClient(owner.clientId, { ...message, requestId: owner.id });
      } else if (message._tag === "Defect") {
        // A connection-level defect fails every request on the socket.
        host.push(message);
        for (const clientId of this.clients.keys()) toClient(clientId, message);
      } else {
        host.push(message);
      }
    }
    for (const [clientId, list] of byClient) {
      this.clients.get(clientId)?.deliver(encodeFrame(list));
    }
    if (host.length === messages.length) return frame;
    return host.length === 0 ? undefined : encodeFrame(host);
  }
}
