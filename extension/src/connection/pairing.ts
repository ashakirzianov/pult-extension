import {
  RemotePairingCodeMissingError,
  type ResolvedRemotePairingTarget,
  resolveRemotePairingTarget,
} from "@t3tools/shared/remote";

export type ConnectInput =
  | { readonly _tag: "PairingLink"; readonly target: ResolvedRemotePairingTarget }
  | {
      readonly _tag: "ServerUrl";
      readonly host: string;
      readonly withToken: (token: string) => ResolvedRemotePairingTarget;
    }
  | { readonly _tag: "Invalid"; readonly message: string };

/**
 * Reads the one input box of "Add environment". A pairing link (`…/pair#token=…`,
 * or a hosted link naming its `host`) carries its credential; anything short of
 * one is a server URL, whose token the next prompt asks for. A URL without a
 * scheme is https, as in Pult.
 */
export function parseConnectInput(text: string): ConnectInput {
  const value = text.trim();
  if (value === "") return { _tag: "Invalid", message: "Enter a pairing link or a server URL." };
  try {
    return { _tag: "PairingLink", target: resolveRemotePairingTarget({ pairingUrl: value }) };
  } catch {
    // Not a complete pairing link: read it as a server URL.
  }
  try {
    resolveRemotePairingTarget({ host: value });
  } catch (error) {
    if (error instanceof RemotePairingCodeMissingError) {
      return {
        _tag: "ServerUrl",
        host: error.host,
        withToken: (token) => resolveRemotePairingTarget({ host: value, pairingCode: token }),
      };
    }
    if (error instanceof Error) return { _tag: "Invalid", message: error.message };
  }
  return { _tag: "Invalid", message: "The server URL is invalid." };
}
