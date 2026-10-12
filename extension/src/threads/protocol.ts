// The messages between the extension host and a thread tab's webview, shared by
// both bundles. The webview's runtime reaches the server only through the host
// (`DECISIONS.md`, `connection-owner`): its sockets are virtual ones the host
// multiplexes onto its own (`socketMux.ts`), and its HTTP to the environment is
// a fetch the host performs.

/** What a tab shows: a server thread, or a draft that becomes one on its first message. */
export type ThreadTarget =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "draft"; readonly draftId: string; readonly projectId: string };

/** The bound environment as a webview's runtime registers it, credential included. */
export interface WebviewEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly connectionId: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearer: string;
}

/** A tab's `localStorage` (`webview/src/storage.ts`), as the host keeps it. */
export type TabStorage = Readonly<Record<string, string>>;

/** Writes to a tab's storage, oldest first: a key and its value, or null where it was removed. */
export type StorageChanges = ReadonlyArray<readonly [key: string, value: string | null]>;

/** Why a tab cannot show its thread, in place of an environment. */
export type Unavailable =
  | { readonly reason: "unbound" }
  | { readonly reason: "other-environment"; readonly label: string };

export type HostMessage =
  | {
      readonly type: "init";
      readonly target: ThreadTarget;
      readonly environment: WebviewEnvironment | Unavailable;
      /** The storage the page starts from: its own, or the one the tab it replaces had. */
      readonly storage: TabStorage;
      /** Outside production the page answers the headless load's `test.*` messages. */
      readonly development: boolean;
    }
  | { readonly type: "socket.opened"; readonly socketId: number }
  | { readonly type: "socket.message"; readonly socketId: number; readonly data: string }
  | {
      readonly type: "socket.closed";
      readonly socketId: number;
      readonly code: number;
      readonly reason: string;
    }
  | {
      readonly type: "fetch.response";
      readonly requestId: number;
      readonly status: number;
      readonly statusText: string;
      readonly headers: ReadonlyArray<readonly [string, string]>;
      readonly body: ArrayBuffer;
    }
  | { readonly type: "fetch.failed"; readonly requestId: number; readonly message: string }
  /** The host's connection is ready again: a webview waiting to reconnect retries now. */
  | { readonly type: "wakeup" }
  /** Answered by `flushed` once every write before it has been reported. */
  | { readonly type: "flush"; readonly requestId: number }
  /** The headless load reads the page's text, or sends a message through its composer. */
  | { readonly type: "test.probe"; readonly requestId: number }
  | { readonly type: "test.send"; readonly requestId: number; readonly text: string };

export type WebviewMessage =
  /** The page loaded, with the storage it saved before, if this tab's page ran before. */
  | { readonly type: "ready"; readonly storage: TabStorage | null }
  | { readonly type: "socket.open"; readonly socketId: number }
  | { readonly type: "socket.send"; readonly socketId: number; readonly data: string }
  | { readonly type: "socket.close"; readonly socketId: number }
  | {
      readonly type: "fetch";
      readonly requestId: number;
      readonly url: string;
      readonly method: string;
      readonly headers: ReadonlyArray<readonly [string, string]>;
      readonly body: ArrayBuffer | null;
    }
  | { readonly type: "fetch.abort"; readonly requestId: number }
  /** Writes to the page's storage, reported as they happen, for the host to carry into a reopened tab. */
  | { readonly type: "storage"; readonly changes: StorageChanges }
  | { readonly type: "flushed"; readonly requestId: number }
  /** A draft tab's first message created its thread. */
  | { readonly type: "promoted"; readonly threadId: string }
  /** The thread view navigated to another thread, which belongs in its own tab. */
  | { readonly type: "open"; readonly threadId: string }
  /** The thread view started a new thread, which belongs in its own tab. */
  | { readonly type: "newThread"; readonly projectId: string }
  | { readonly type: "openExternal"; readonly url: string }
  | { readonly type: "command"; readonly command: "pult.connect" }
  /** An error the page hit, for the extension host's log, where a developer looks. */
  | { readonly type: "log"; readonly text: string }
  | {
      readonly type: "test.result";
      readonly requestId: number;
      readonly text: string;
      readonly error: string | null;
    };
