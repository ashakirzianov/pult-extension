// A thread tab's resource (`pult/decisions`, `thread-tab-editor`):
//
//   pult-thread://<environment>/<threadId>/<title>
//   pult-thread://<environment>/draft/<draftId>/New Thread?project=<projectId>
//
// The thread id keys decorations, menus and citations; the last segment is only
// the tab's label, which VS Code takes from the basename, so a thread whose
// title changes is reopened at its new URI. A draft names its project in the
// query, so a restored draft tab knows where to start its thread.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type { ThreadTarget } from "./protocol.ts";

export const THREAD_SCHEME = "pult-thread";
export const THREAD_VIEW_TYPE = "pult.thread";
export const DRAFT_TITLE = "New Thread";

/** The parts of a URI this module reads and writes, `vscode.Uri`'s among them. */
export interface UriComponents {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
}

export interface ThreadResource {
  readonly environmentId: string;
  readonly target: ThreadTarget;
  readonly title: string;
}

const UNTITLED = "Untitled thread";

/** The title as a path segment: a slash would split it, so a lookalike stands in. */
export function titleSegment(title: string): string {
  const flat = title.replaceAll(/\s+/g, " ").trim();
  return flat === "" ? UNTITLED : flat.replaceAll("/", "∕");
}

export function threadUri(environmentId: string, threadId: string, title: string): UriComponents {
  return {
    scheme: THREAD_SCHEME,
    authority: environmentId,
    path: `/${threadId}/${titleSegment(title)}`,
    query: "",
  };
}

export function draftUri(environmentId: string, draftId: string, projectId: string): UriComponents {
  return {
    scheme: THREAD_SCHEME,
    authority: environmentId,
    path: `/draft/${draftId}/${DRAFT_TITLE}`,
    query: new URLSearchParams({ project: projectId }).toString(),
  };
}

export function parseThreadUri(uri: UriComponents): ThreadResource | null {
  if (uri.scheme !== THREAD_SCHEME || uri.authority === "") return null;
  const segments = uri.path.split("/").slice(1);
  if (segments[0] === "draft") {
    const [, draftId, title] = segments;
    const projectId = new URLSearchParams(uri.query).get("project");
    if (!draftId || !title || !projectId || segments.length !== 3) return null;
    return {
      environmentId: uri.authority,
      target: { kind: "draft", draftId, projectId },
      title,
    };
  }
  const [threadId, title] = segments;
  if (!threadId || !title || segments.length !== 2) return null;
  return { environmentId: uri.authority, target: { kind: "thread", threadId }, title };
}

/** What a tab reads of a thread to know which URI names it. */
export type TitledThread = Pick<
  EnvironmentThreadShell,
  "title" | "titleRegeneration" | "latestRun"
>;

/**
 * The URI a tab belongs at, or null where it is right. A thread tab follows
 * its thread's title. A draft tab whose thread exists (`promotedTo`) waits for
 * the title the server generates from the first message, so it moves once,
 * unless the tab was just shown, when its page loads again anyway.
 */
export function followedUri(input: {
  readonly resource: ThreadResource;
  readonly promotedTo: string | null;
  readonly thread: (threadId: string) => TitledThread | undefined;
  readonly shown: boolean;
}): UriComponents | null {
  const { resource, promotedTo } = input;
  const { environmentId, target } = resource;
  if (target.kind === "thread") {
    const thread = input.thread(target.threadId);
    return thread === undefined || titleSegment(thread.title) === resource.title
      ? null
      : threadUri(environmentId, target.threadId, thread.title);
  }
  if (promotedTo === null) return null;
  const thread = input.thread(promotedTo);
  // The first message starts a run and a title generation together.
  const titled =
    thread !== undefined && thread.latestRun !== null && thread.titleRegeneration == null;
  return titled || input.shown ? threadUri(environmentId, promotedTo, thread?.title ?? "") : null;
}

/** What a tab's decorations and menus key on: the environment and the thread, never the title. */
export function threadKey(environmentId: string, threadId: string): string {
  return `${environmentId}/${threadId}`;
}
