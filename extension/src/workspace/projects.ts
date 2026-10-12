import type { OrchestrationProjectShell, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { baseName } from "./paths.ts";

/** A directory "Pult: Open Project" offers as a workspace folder. Paths are the host's. */
export interface ProjectRoot {
  readonly path: string;
  /** The workspace folder's name. */
  readonly name: string;
  readonly project: string;
  /** Set for a worktree: its branch, or its directory's name if the thread has none. */
  readonly worktree: string | null;
}

/**
 * Each project's root, then the worktrees its live threads run in, the most
 * recently updated thread first; projects by title.
 */
export function projectRoots(shell: {
  readonly projects: ReadonlyArray<
    Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">
  >;
  readonly threads: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadShell,
      "projectId" | "worktreePath" | "branch" | "deletedAt" | "updatedAt"
    >
  >;
}): Array<ProjectRoot> {
  const threads = shell.threads
    .filter((thread) => thread.deletedAt === null)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
  const roots: Array<ProjectRoot> = [];
  for (const project of shell.projects.toSorted((left, right) =>
    left.title.localeCompare(right.title),
  )) {
    roots.push({
      path: project.workspaceRoot,
      name: project.title,
      project: project.title,
      worktree: null,
    });
    const worktrees = new Set([project.workspaceRoot]);
    for (const thread of threads) {
      const path = thread.worktreePath;
      if (thread.projectId !== project.id || path === null || worktrees.has(path)) continue;
      worktrees.add(path);
      const worktree = thread.branch ?? baseName(path);
      roots.push({
        path,
        name: `${project.title} · ${worktree}`,
        project: project.title,
        worktree,
      });
    }
  }
  return roots;
}

/**
 * The host roots of the threads whose run completed since `seen`, and each
 * thread's last completion now, in epoch milliseconds, `0` for none yet. A
 * thread first seen reports nothing, so connecting replays no old turns.
 */
export function endedTurns(
  seen: ReadonlyMap<string, number>,
  shell: {
    readonly projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "workspaceRoot">>;
    readonly threads: ReadonlyArray<
      Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "worktreePath" | "latestRunCompletedAt">
    >;
  },
): { readonly seen: Map<string, number>; readonly roots: Set<string> } {
  const projects = new Map(shell.projects.map((project) => [project.id, project.workspaceRoot]));
  const next = new Map<string, number>();
  const roots = new Set<string>();
  for (const thread of shell.threads) {
    const completed = thread.latestRunCompletedAt;
    const at =
      completed === null || completed === undefined ? 0 : DateTime.toEpochMillis(completed);
    next.set(thread.id, at);
    const before = seen.get(thread.id);
    const root = thread.worktreePath ?? projects.get(thread.projectId);
    if (before !== undefined && at > before && root !== undefined) roots.add(root);
  }
  return { seen: next, roots };
}
