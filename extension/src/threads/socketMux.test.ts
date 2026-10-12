import { describe, expect, it } from "vite-plus/test";

import { parseClientRequestId, SocketMux } from "./socketMux.ts";

function setup() {
  const upstream: Array<unknown> = [];
  const mux = new SocketMux((frame) => upstream.push(JSON.parse(frame)));
  const delivered = new Map<number, Array<unknown>>();
  const attach = (clientId: number) => {
    delivered.set(clientId, []);
    mux.attach(clientId, (frame) => delivered.get(clientId)!.push(JSON.parse(frame)));
  };
  return { mux, upstream, delivered, attach };
}

const request = (id: string | number) => ({
  _tag: "Request",
  id,
  tag: "orchestration.getThread",
  payload: { threadId: "t1" },
  headers: [],
});

describe("SocketMux", () => {
  it("passes the host's frames through untouched while no client is attached", () => {
    const { mux } = setup();
    const frame = '{"_tag":"Exit","requestId":"pult:1:n:0","exit":{"_tag":"Success","value":1}}';
    expect(mux.fromServer(frame)).toBe(frame);
  });

  it("gives a client's request its own id upstream and the response back under the client's", () => {
    const { mux, upstream, delivered, attach } = setup();
    attach(3);
    mux.fromClient(3, JSON.stringify(request(7)));
    expect(upstream).toEqual([{ ...request("pult:3:n:7") }]);

    const exit = { _tag: "Exit", requestId: "pult:3:n:7", exit: { _tag: "Success", value: 1 } };
    expect(mux.fromServer(JSON.stringify(exit))).toBeUndefined();
    expect(delivered.get(3)).toEqual([{ ...exit, requestId: 7 }]);
  });

  it("keeps a string id a string", () => {
    expect(parseClientRequestId("pult:2:s:a:b")).toEqual({ clientId: 2, id: "a:b" });
    expect(parseClientRequestId("pult:2:n:41")).toEqual({ clientId: 2, id: 41 });
    expect(parseClientRequestId(41)).toBeNull();
    expect(parseClientRequestId("41")).toBeNull();
  });

  it("splits a batch between the host and each client", () => {
    const { mux, delivered, attach } = setup();
    attach(1);
    attach(2);
    const hostChunk = { _tag: "Chunk", requestId: 5, values: ["a"] };
    const frame = JSON.stringify([
      { _tag: "Chunk", requestId: "pult:1:n:0", values: ["b"] },
      hostChunk,
      { _tag: "Chunk", requestId: "pult:2:n:0", values: ["c"] },
      { _tag: "Pong" },
    ]);
    expect(JSON.parse(mux.fromServer(frame)!)).toEqual([hostChunk, { _tag: "Pong" }]);
    expect(delivered.get(1)).toEqual([{ _tag: "Chunk", requestId: 0, values: ["b"] }]);
    expect(delivered.get(2)).toEqual([{ _tag: "Chunk", requestId: 0, values: ["c"] }]);
  });

  it("answers a client's ping itself and drops its end-of-input", () => {
    const { mux, upstream, delivered, attach } = setup();
    attach(1);
    mux.fromClient(1, '{"_tag":"Ping"}');
    mux.fromClient(1, '{"_tag":"Eof"}');
    expect(upstream).toEqual([]);
    expect(delivered.get(1)).toEqual([{ _tag: "Pong" }]);
  });

  it("rewrites the ids of a client's acks and interrupts", () => {
    const { mux, upstream, attach } = setup();
    attach(4);
    mux.fromClient(4, '[{"_tag":"Ack","requestId":2},{"_tag":"Interrupt","requestId":"x"}]');
    expect(upstream).toEqual([
      [
        { _tag: "Ack", requestId: "pult:4:n:2" },
        { _tag: "Interrupt", requestId: "pult:4:s:x" },
      ],
    ]);
  });

  it("interrupts what a detached client left running, and only that", () => {
    const { mux, upstream, attach } = setup();
    attach(1);
    mux.fromClient(1, JSON.stringify(request(0)));
    mux.fromClient(1, JSON.stringify(request(1)));
    mux.fromServer(JSON.stringify({ _tag: "Exit", requestId: "pult:1:n:0", exit: {} }));
    upstream.length = 0;
    mux.detach(1);
    expect(upstream).toEqual([{ _tag: "Interrupt", requestId: "pult:1:n:1" }]);
  });

  it("drops responses for a detached client", () => {
    const { mux, attach } = setup();
    attach(1);
    mux.detach(1);
    attach(2);
    expect(
      mux.fromServer(JSON.stringify({ _tag: "Chunk", requestId: "pult:1:n:0", values: [1] })),
    ).toBeUndefined();
  });

  it("sends a connection-level defect to everyone", () => {
    const { mux, delivered, attach } = setup();
    attach(1);
    const defect = { _tag: "Defect", defect: "boom" };
    expect(JSON.parse(mux.fromServer(JSON.stringify(defect))!)).toEqual(defect);
    expect(delivered.get(1)).toEqual([defect]);
  });
});
