import * as vscode from "vscode";

import type { EnvironmentCatalog } from "../connection/catalog.ts";
import type { WindowConnection } from "../connection/service.ts";
import type { ThreadsModel } from "./model.ts";
import type {
  HostMessage,
  TabStorage,
  ThreadTarget,
  Unavailable,
  WebviewEnvironment,
  WebviewMessage,
} from "./protocol.ts";
import type { SocketHub, VirtualSocket } from "./socketHub.ts";
import { applyChanges, CarriedStorage } from "./tabStorage.ts";
import {
  draftUri,
  followedUri,
  parseThreadUri,
  THREAD_VIEW_TYPE,
  threadUri,
  type ThreadResource,
} from "./uri.ts";

interface Dependencies {
  readonly development: boolean;
  readonly extensionUri: vscode.Uri;
  readonly catalog: EnvironmentCatalog;
  readonly connection: WindowConnection;
  readonly hub: SocketHub;
  readonly model: ThreadsModel;
}

/** Opens a thread's tab, or a new draft's, in the active group unless told otherwise. */
export function openThreadTab(
  target: ThreadTarget,
  environmentId: string,
  title: string,
  options: vscode.TextDocumentShowOptions = {},
): Thenable<unknown> {
  const uri =
    target.kind === "thread"
      ? threadUri(environmentId, target.threadId, title)
      : draftUri(environmentId, target.draftId, target.projectId);
  return vscode.commands.executeCommand("vscode.openWith", vscode.Uri.from(uri), THREAD_VIEW_TYPE, {
    preview: false,
    ...options,
  });
}

/**
 * The `pult.thread` custom editor (`DECISIONS.md`, `thread-tab-editor`): a
 * thread tab's webview runs the thread bundle, whose runtime reaches the
 * server through this host. A visible tab whose thread's title changed, or
 * whose draft's thread has its generated title, is reopened at its new URI with
 * the page's storage (`followedUri`); a hidden one, when it is next shown.
 */
export class ThreadEditorProvider
  implements vscode.CustomReadonlyEditorProvider, vscode.Disposable
{
  private readonly deps: Dependencies;
  private readonly panels = new Set<ThreadPanel>();
  private readonly carried = new CarriedStorage();
  private readonly subscriptions: Array<vscode.Disposable>;
  private boundEnvironmentId: string | null;

  constructor(deps: Dependencies) {
    this.deps = deps;
    this.boundEnvironmentId = deps.connection.environment?.environmentId ?? null;
    this.subscriptions = [
      deps.connection.onDidChange(() => {
        const environmentId = this.deps.connection.environment?.environmentId ?? null;
        if (environmentId === this.boundEnvironmentId) return;
        this.boundEnvironmentId = environmentId;
        for (const panel of this.panels) panel.reload();
      }),
      deps.hub.onDidOpen(() => {
        for (const panel of this.panels) panel.post({ type: "wakeup" });
      }),
      deps.model.onDidChange(() => {
        for (const panel of this.panels) this.follow(panel, false);
      }),
    ];
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): void {
    const resource = parseThreadUri(document.uri);
    if (resource === null) {
      webviewPanel.webview.html = `<!doctype html><p>Not a Pult thread: ${escapeHtml(document.uri.toString())}</p>`;
      return;
    }
    const seed = this.carried.take(document.uri.toString(), webviewPanel.viewColumn);
    const panel = new ThreadPanel(this, document.uri, resource, webviewPanel, seed);
    this.panels.add(panel);
    webviewPanel.onDidDispose(() => {
      panel.dispose();
      this.panels.delete(panel);
    });
    let visible = webviewPanel.visible;
    webviewPanel.onDidChangeViewState(() => {
      const shown = panel.visible && !visible;
      visible = panel.visible;
      // A hidden tab's page is gone, without closing what it had open.
      if (!panel.visible) panel.closeTransport();
      else if (shown) this.follow(panel, true);
    });
    this.follow(panel, true);
  }

  /** @internal What a webview's runtime registers, or why the tab cannot show its thread. */
  async environmentFor(resource: ThreadResource): Promise<WebviewEnvironment | Unavailable> {
    const { catalog, connection } = this.deps;
    const bound = connection.environment;
    if (bound === null) return { reason: "unbound" };
    if (bound.environmentId !== resource.environmentId) {
      const label = catalog.profile(resource.environmentId)?.label ?? resource.environmentId;
      return { reason: "other-environment", label };
    }
    const profile = catalog.profile(bound.environmentId);
    const bearer = await catalog.credential(bound.environmentId);
    if (profile === undefined || bearer === undefined) return { reason: "unbound" };
    return {
      environmentId: profile.environmentId,
      label: profile.label,
      connectionId: profile.connectionId,
      httpBaseUrl: profile.httpBaseUrl,
      wsBaseUrl: profile.wsBaseUrl,
      bearer,
    };
  }

  /** @internal */
  get hub(): SocketHub {
    return this.deps.hub;
  }

  /** @internal */
  get development(): boolean {
    return this.deps.development;
  }

  /** Outside production, the headless load's handle on a tab (`test/load.ts`): its page's text. */
  probe(uri: string): Promise<string> {
    return this.panelAt(uri).test({ type: "test.probe" });
  }

  /** Outside production: sends a message through the tab's composer. */
  async send(uri: string, text: string): Promise<void> {
    await this.panelAt(uri).test({ type: "test.send", text });
  }

  private panelAt(uri: string): ThreadPanel {
    const panel = [...this.panels].find((each) => each.uri.toString() === uri);
    if (panel === undefined) throw new Error(`No thread tab is open at ${uri}.`);
    return panel;
  }

  /** @internal */
  get extensionUri(): vscode.Uri {
    return this.deps.extensionUri;
  }

  /** @internal A webview's request to show another thread, which opens in its own tab. */
  open(threadId: string, environmentId: string, column: vscode.ViewColumn | undefined) {
    const title = this.deps.model.thread(threadId)?.title ?? "";
    void openThreadTab(
      { kind: "thread", threadId },
      environmentId,
      title,
      column === undefined ? {} : { viewColumn: column },
    );
  }

  /** @internal A draft tab's thread exists: the tab follows it (`followedUri`). */
  promoted(panel: ThreadPanel, threadId: string) {
    panel.promotedTo = threadId;
    this.follow(panel, false);
  }

  /** Reopens a visible tab whose URI no longer names what it shows; `shown` if it just came into view. */
  private follow(panel: ThreadPanel, shown: boolean) {
    if (panel.visible && this.destination(panel, shown) !== null) void this.reopen(panel, shown);
  }

  private destination(panel: ThreadPanel, shown: boolean): vscode.Uri | null {
    const { model } = this.deps;
    const uri = followedUri({
      resource: panel.resource,
      promotedTo: panel.promotedTo,
      thread: (threadId) =>
        panel.resource.environmentId === model.environmentId ? model.thread(threadId) : undefined,
      shown,
    });
    return uri === null ? null : vscode.Uri.from(uri);
  }

  private async reopen(panel: ThreadPanel, shown: boolean) {
    if (panel.reopening) return;
    panel.reopening = true;
    try {
      // The page's last writes, before its storage moves to the new tab.
      await panel.flush();
      const uri = this.destination(panel, shown);
      const tab = this.tabOf(panel);
      // Opening a tab in a group shows it, so a tab hidden meanwhile waits to be shown.
      if (uri === null || tab === undefined || !panel.visible) return;
      const column = tab.group.viewColumn;
      const drop =
        panel.storage === null ? () => {} : this.carried.put(uri.toString(), column, panel.storage);
      try {
        await vscode.commands.executeCommand("vscode.openWith", uri, THREAD_VIEW_TYPE, {
          preview: false,
          preserveFocus: !panel.active,
          viewColumn: column,
        });
      } finally {
        // The new tab took it, unless one was open at the URI in that group already.
        drop();
      }
      await vscode.window.tabGroups.close(tab, true);
    } finally {
      panel.reopening = false;
    }
  }

  /** The panel's tab: the one at its URI in its group, or else the only one at its URI. */
  private tabOf(panel: ThreadPanel): vscode.Tab | undefined {
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputCustom &&
          tab.input.viewType === THREAD_VIEW_TYPE &&
          tab.input.uri.toString() === panel.uri.toString(),
      );
    return (
      tabs.find((tab) => tab.group.viewColumn === panel.column) ??
      (tabs.length === 1 ? tabs[0] : undefined)
    );
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

// A page that is still loading cannot answer a flush; its writes are all in.
const FLUSH_WAIT_MS = 1_000;

// A send waits for the composer to offer to send, which the page bounds itself.
const TEST_ANSWER_MS = 45_000;

/** One thread tab's webview and what the host does for it. */
class ThreadPanel {
  readonly uri: vscode.Uri;
  readonly resource: ThreadResource;
  /** The page's storage as of its last report, carried into a reopened tab. */
  storage: TabStorage | null;
  /** The thread a draft tab's page went on to show, once its first message created it. */
  promotedTo: string | null = null;
  reopening = false;
  /** Whether the page is up: it said `ready`, and the tab has not hidden since. */
  private live = false;
  private readonly provider: ThreadEditorProvider;
  private readonly panel: vscode.WebviewPanel;
  private readonly sockets = new Map<number, VirtualSocket>();
  private readonly fetches = new Map<number, AbortController>();
  private readonly tests = new Map<
    number,
    (result: { text: string; error: string | null }) => void
  >();
  private readonly flushes = new Map<number, () => void>();
  private nextRequestId = 1;
  private readonly subscription: vscode.Disposable;
  private origin: string | null = null;

  constructor(
    provider: ThreadEditorProvider,
    uri: vscode.Uri,
    resource: ThreadResource,
    panel: vscode.WebviewPanel,
    storage: TabStorage | null,
  ) {
    this.provider = provider;
    this.uri = uri;
    this.resource = resource;
    this.panel = panel;
    this.storage = storage;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(provider.extensionUri, "dist", "webview")],
    };
    this.subscription = panel.webview.onDidReceiveMessage((message: WebviewMessage) =>
      this.receive(message),
    );
    void this.render();
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  get active(): boolean {
    return this.panel.active;
  }

  get column(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn;
  }

  post(message: HostMessage) {
    // A webview's postMessage, which takes no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    void this.panel.webview.postMessage(message);
  }

  /** @internal Outside production: a `test.*` request to the page, answered by its `test.result`. */
  test(
    message:
      | { readonly type: "test.probe" }
      | { readonly type: "test.send"; readonly text: string },
  ): Promise<string> {
    if (!this.provider.development) return Promise.reject(new Error("Test hooks are off."));
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      // A page that never loaded never answers.
      const timer = setTimeout(() => {
        this.tests.delete(requestId);
        reject(new Error("The thread tab's page did not answer."));
      }, TEST_ANSWER_MS);
      this.tests.set(requestId, ({ text, error }) => {
        clearTimeout(timer);
        if (error === null) resolve(text);
        else reject(new Error(error));
      });
      this.post({ ...message, requestId });
    });
  }

  /** Resolves once the page has reported every write so far; a page that is not up has. */
  flush(): Promise<void> {
    if (!this.live) return Promise.resolve();
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.flushes.delete(requestId);
        resolve();
      };
      const timer = setTimeout(done, FLUSH_WAIT_MS);
      this.flushes.set(requestId, done);
      this.post({ type: "flush", requestId });
    });
  }

  /** A fresh page: after the window's environment changed, the tab starts over. */
  reload() {
    this.closeTransport();
    void this.render();
  }

  private async render() {
    const environment = await this.provider.environmentFor(this.resource);
    this.origin = "reason" in environment ? null : new URL(environment.httpBaseUrl).origin;
    this.panel.webview.html = threadHtml(
      this.panel.webview,
      this.provider.extensionUri,
      this.origin,
    );
  }

  private async receive(message: WebviewMessage) {
    switch (message.type) {
      case "ready":
        // A page loading again after the tab was hidden starts from nothing.
        this.closeTransport();
        this.live = true;
        // The page's own storage, after hiding or a window reload, or else
        // what the host has: a reopened tab's carried storage.
        this.storage = message.storage ?? this.storage ?? {};
        this.post({
          type: "init",
          target: this.resource.target,
          environment: await this.provider.environmentFor(this.resource),
          storage: this.storage,
          development: this.provider.development,
        });
        return;
      case "socket.open": {
        const { socketId } = message;
        const socket = this.provider.hub.open({
          opened: () => this.post({ type: "socket.opened", socketId }),
          message: (data) => this.post({ type: "socket.message", socketId, data }),
          closed: (code, reason) => {
            this.sockets.delete(socketId);
            this.post({ type: "socket.closed", socketId, code, reason });
          },
        });
        this.sockets.set(socketId, socket);
        return;
      }
      case "socket.send":
        this.sockets.get(message.socketId)?.send(message.data);
        return;
      case "socket.close":
        this.sockets.get(message.socketId)?.close();
        this.sockets.delete(message.socketId);
        return;
      case "fetch":
        return this.fetch(message);
      case "fetch.abort":
        this.fetches.get(message.requestId)?.abort();
        this.fetches.delete(message.requestId);
        return;
      case "storage":
        this.storage = applyChanges(this.storage ?? {}, message.changes);
        return;
      case "flushed":
        this.flushes.get(message.requestId)?.();
        return;
      case "promoted":
        this.provider.promoted(this, message.threadId);
        return;
      case "open":
        this.provider.open(message.threadId, this.resource.environmentId, this.column);
        return;
      case "newThread":
        void vscode.commands.executeCommand("pult.newThread", message.projectId);
        return;
      case "openExternal": {
        const uri = vscode.Uri.parse(message.url);
        if (["http", "https", "mailto"].includes(uri.scheme)) void vscode.env.openExternal(uri);
        return;
      }
      case "command":
        void vscode.commands.executeCommand(message.command);
        return;
      case "log":
        console.error(`[pult thread tab ${this.uri.path}] ${message.text}`);
        return;
      case "test.result":
        this.tests.get(message.requestId)?.(message);
        this.tests.delete(message.requestId);
        return;
    }
  }

  /** The webview's HTTP to its environment, from this host, whose origin the server admits. */
  private async fetch(message: Extract<WebviewMessage, { type: "fetch" }>) {
    const { requestId } = message;
    if (this.origin === null || new URL(message.url).origin !== this.origin) {
      this.post({
        type: "fetch.failed",
        requestId,
        message: "Pult forwards a thread tab's requests to its environment only.",
      });
      return;
    }
    const controller = new AbortController();
    this.fetches.set(requestId, controller);
    try {
      const response = await fetch(message.url, {
        method: message.method,
        headers: message.headers.map(([name, value]) => [name, value]),
        ...(message.body === null ? {} : { body: message.body }),
        signal: controller.signal,
      });
      const body = await response.arrayBuffer();
      this.post({
        type: "fetch.response",
        requestId,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
        body,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.post({ type: "fetch.failed", requestId, message: String(error) });
      }
    } finally {
      this.fetches.delete(requestId);
    }
  }

  closeTransport() {
    // The page is gone, and its writes with it are all in.
    this.live = false;
    for (const done of this.flushes.values()) done();
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
    for (const controller of this.fetches.values()) controller.abort();
    this.fetches.clear();
  }

  dispose() {
    this.closeTransport();
    this.subscription.dispose();
  }
}

function threadHtml(webview: vscode.Webview, extensionUri: vscode.Uri, origin: string | null) {
  const bundle = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(bundle, "thread.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(bundle, "thread.css"));
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const source = webview.cspSource;
  // The environment serves signed asset URLs to images and media; everything
  // else the page needs is the bundle's, and its fetches go through the host.
  const environment = origin ?? "";
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${source} 'wasm-unsafe-eval'`,
    `style-src ${source} 'unsafe-inline'`,
    `font-src ${source} data:`,
    `img-src ${source} ${environment} https: data: blob:`,
    `media-src ${source} ${environment} blob: data:`,
    `connect-src ${source}`,
    "worker-src blob:",
    "frame-src blob: data:",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="${style}" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}
