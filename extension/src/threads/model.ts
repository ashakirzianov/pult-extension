import { getInitialServerConfig } from "@t3tools/client-runtime/rpc";
import {
  type EnvironmentThreadShell,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as vscode from "vscode";

import type { WindowConnection } from "../connection/service.ts";
import { NO_THREAD_FEATURES, type ThreadFeatures } from "./presentation.ts";

interface Held {
  readonly environmentId: EnvironmentId;
  readonly shell: OrchestrationV2ShellSnapshot;
  readonly threads: ReadonlyMap<string, EnvironmentThreadShell>;
}

/**
 * The bound environment's projects and threads for the picker, the tabs and
 * their decorations. A registry entry change restarts the vendored stream with
 * an empty snapshot (`WindowConnection`); the last snapshot is held through
 * that, and dropped only when the window's environment changes. The thread
 * features its server advertises are read on each connect, and set as the
 * `pult.threadSettlement`, `pult.threadSnooze` and `pult.threadPinning`
 * context keys for the menus.
 */
export class ThreadsModel implements vscode.Disposable {
  private held: Held | null = null;
  private featureSet: {
    readonly environmentId: EnvironmentId;
    readonly features: ThreadFeatures;
  } | null = null;
  private wasReady = false;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly subscription: vscode.Disposable;

  constructor(connection: WindowConnection) {
    const update = () => {
      const environment = connection.environment;
      const ready = environment?.phase === "ready";
      if (ready && !this.wasReady) void this.loadFeatures(connection, environment.environmentId);
      this.wasReady = ready;
      if (
        this.featureSet !== null &&
        this.featureSet.environmentId !== environment?.environmentId
      ) {
        this.setFeatures(null);
      }
      const shell = Option.getOrUndefined(environment?.shell ?? Option.none());
      if (environment === null) {
        if (this.held === null) return;
        this.held = null;
      } else if (shell !== undefined) {
        if (this.held?.shell === shell) return;
        this.held = {
          environmentId: environment.environmentId,
          shell,
          threads: new Map(
            shell.threads.map((thread) => [
              thread.id,
              presentThreadShell(environment.environmentId, thread),
            ]),
          ),
        };
      } else if (this.held !== null && this.held.environmentId !== environment.environmentId) {
        this.held = null;
      } else return;
      this.changes.fire();
    };
    update();
    this.subscription = connection.onDidChange(update);
  }

  private async loadFeatures(connection: WindowConnection, environmentId: EnvironmentId) {
    const capabilities = await connection.run(getInitialServerConfig()).then(
      (config) => config.environment.capabilities,
      (error: unknown) => {
        // Asked again on the connection's next change while it is ready.
        console.warn(`Pult could not read the server's thread features: ${String(error)}`);
        this.wasReady = false;
        return null;
      },
    );
    if (capabilities === null || connection.environment?.environmentId !== environmentId) return;
    this.setFeatures({
      environmentId,
      features: {
        settlement: capabilities.threadSettlement === true,
        snooze: capabilities.threadSnooze === true,
        pinning: capabilities.threadPinning === true,
      },
    });
  }

  private setFeatures(next: ThreadsModel["featureSet"]) {
    this.featureSet = next;
    const features = next?.features ?? NO_THREAD_FEATURES;
    void vscode.commands.executeCommand("setContext", "pult.threadSettlement", features.settlement);
    void vscode.commands.executeCommand("setContext", "pult.threadSnooze", features.snooze);
    void vscode.commands.executeCommand("setContext", "pult.threadPinning", features.pinning);
    this.changes.fire();
  }

  /** What the bound environment's server advertises; none until it has said. */
  get features(): ThreadFeatures {
    return this.featureSet?.features ?? NO_THREAD_FEATURES;
  }

  /** The environment the held snapshot is of. */
  get environmentId(): EnvironmentId | null {
    return this.held?.environmentId ?? null;
  }

  /** Whether the snapshot and the server's features are both in. */
  get loaded(): boolean {
    return this.held !== null && this.featureSet?.environmentId === this.held.environmentId;
  }

  threads(): ReadonlyArray<EnvironmentThreadShell> {
    return [...(this.held?.threads.values() ?? [])];
  }

  thread(threadId: string): EnvironmentThreadShell | undefined {
    return this.held?.threads.get(threadId);
  }

  projects(): ReadonlyArray<OrchestrationProjectShell> {
    return this.held?.shell.projects ?? [];
  }

  project(projectId: string): OrchestrationProjectShell | undefined {
    return this.held?.shell.projects.find((project) => project.id === projectId);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changes.dispose();
  }
}
