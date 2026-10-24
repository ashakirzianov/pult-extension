import { request } from "@t3tools/client-runtime/rpc";
import { WS_METHODS, type OrchestrationProjectShell } from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import * as Option from "effect/Option";
import * as vscode from "vscode";

import type { WindowConnection } from "../connection/service.ts";

// A monogram's backgrounds, readable under white text on light and dark themes.
const MONOGRAM_COLORS = [
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#d97706",
  "#059669",
  "#0891b2",
];

/** A project without a favicon: its initial on a colour its id picks. */
export function monogram(project: Pick<OrchestrationProjectShell, "id" | "title">): vscode.Uri {
  const initial = /[\p{L}\p{N}]/u.exec(project.title)?.[0]?.toUpperCase() ?? "?";
  let hash = 0;
  for (const char of project.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const color = MONOGRAM_COLORS[hash % MONOGRAM_COLORS.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${color}"/><text x="8" y="12" font-family="system-ui, sans-serif" font-size="10" font-weight="600" fill="#fff" text-anchor="middle">${initial.replace(/[<>&"]/g, "")}</text></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

function dataUri(contentType: string, bytes: Uint8Array): vscode.Uri {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return vscode.Uri.parse(`data:${contentType};base64,${btoa(binary)}`);
}

/**
 * Project icons for the picker: the project's favicon through the server's
 * `project-favicon` asset, inlined, since a tree item cannot send credentials
 * and a signed URL expires; a monogram while it loads and when there is none.
 */
export class ProjectFavicons implements vscode.Disposable {
  private readonly connection: WindowConnection;
  private readonly icons = new Map<string, vscode.Uri | "loading">();
  private environmentId: string | null = null;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;

  constructor(connection: WindowConnection) {
    this.connection = connection;
  }

  icon(project: OrchestrationProjectShell): vscode.Uri {
    const environment = this.connection.environment;
    if (environment?.environmentId !== this.environmentId) {
      this.icons.clear();
      this.environmentId = environment?.environmentId ?? null;
    }
    const key = `${project.id}\0${project.workspaceRoot}\0${project.faviconPath ?? ""}`;
    const known = this.icons.get(key);
    if (known !== undefined && known !== "loading") return known;
    if (known === undefined && environment?.phase === "ready") {
      this.icons.set(key, "loading");
      void this.load(project).then(
        (icon) => {
          this.icons.set(key, icon ?? monogram(project));
          if (icon !== null) this.changes.fire();
        },
        // A failed load retries when the picker next asks.
        () => this.icons.delete(key),
      );
    }
    return monogram(project);
  }

  private async load(project: OrchestrationProjectShell): Promise<vscode.Uri | null> {
    const asset = await this.connection.run(
      request(WS_METHODS.assetsCreateUrl, {
        resource: {
          _tag: "project-favicon",
          cwd: project.workspaceRoot,
          ...(project.faviconPath ? { path: project.faviconPath } : {}),
        },
      }),
    );
    if (isProjectFaviconFallbackUrl(asset.relativeUrl)) return null;
    const prepared = Option.getOrUndefined(this.connection.environment?.prepared ?? Option.none());
    if (prepared === undefined) throw new Error("The environment is not connected.");
    const response = await this.connection.fetch(new URL(asset.relativeUrl, prepared.httpBaseUrl));
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
    return dataUri(contentType, new Uint8Array(await response.arrayBuffer()));
  }

  dispose(): void {
    this.changes.dispose();
  }
}
