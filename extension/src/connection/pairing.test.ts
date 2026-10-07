import { describe, expect, it } from "vite-plus/test";

import { parseConnectInput } from "./pairing.ts";

describe("parseConnectInput", () => {
  it("reads a pairing link's address and token", () => {
    expect(parseConnectInput("http://localhost:3773/pair#token=ABCDEFGHJKLM")).toEqual({
      _tag: "PairingLink",
      target: {
        httpBaseUrl: "http://localhost:3773/",
        wsBaseUrl: "ws://localhost:3773/",
        credential: "ABCDEFGHJKLM",
      },
    });
  });

  it("reads the backend of a hosted pairing link", () => {
    const link = `https://app.t3.codes/pair?host=${encodeURIComponent("https://studio.tail.ts.net")}&label=Studio#token=ABCDEFGHJKLM`;
    expect(parseConnectInput(link)).toEqual({
      _tag: "PairingLink",
      target: {
        httpBaseUrl: "https://studio.tail.ts.net/",
        wsBaseUrl: "wss://studio.tail.ts.net/",
        credential: "ABCDEFGHJKLM",
      },
    });
  });

  it("reads anything short of a pairing link as a server URL, whose token comes next", () => {
    const input = parseConnectInput("http://localhost:3773/pair");
    if (input._tag !== "ServerUrl") throw new Error(`Expected a server URL, got ${input._tag}.`);

    expect(input.host).toBe("localhost:3773");
    expect(input.withToken("session-token")).toEqual({
      httpBaseUrl: "http://localhost:3773/",
      wsBaseUrl: "ws://localhost:3773/",
      credential: "session-token",
    });
  });

  it("takes a server without a scheme as https", () => {
    const input = parseConnectInput("studio.tail.ts.net");
    if (input._tag !== "ServerUrl") throw new Error(`Expected a server URL, got ${input._tag}.`);

    expect(input.withToken("code").httpBaseUrl).toBe("https://studio.tail.ts.net/");
  });

  it("refuses an empty input and an address that is not http or WebSocket", () => {
    expect(parseConnectInput("  ")._tag).toBe("Invalid");
    expect(parseConnectInput("ftp://studio/pair#token=ABCDEFGHJKLM")._tag).toBe("Invalid");
  });
});
