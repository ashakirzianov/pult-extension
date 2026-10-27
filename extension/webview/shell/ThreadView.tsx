// The app around upstream's thread view in Pult's shell: one thread, or one
// project's draft, per pane, on the shell's connection. A draft follows itself
// into the thread it creates; a navigation to another thread or a new one
// opens it in the shell.
import { type AnyRouter, Outlet, RouterProvider, useRouter } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveProviderSubagentStatus } from "@t3tools/client-runtime/state/thread-execution";
import {
  EnvironmentId,
  isOrchestrationV2WorkActive,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { type ReactNode, StrictMode, useEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { ComposerControlsSlot } from "../t3/src/components/chat/ChatComposer";
import { ConfirmDialogHost } from "../t3/src/components/ConfirmDialogHost";
import { CustomSnoozeDialogHost } from "../t3/src/components/CustomSnoozeDialog";
import { SidebarProvider } from "../t3/src/components/ui/sidebar";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../t3/src/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "../t3/src/composerDraftStore";
import { useNewThreadHandler } from "../t3/src/hooks/useHandleNewThread";
import { AppAtomRegistryProvider } from "../t3/src/rpc/atomRegistry";
import { useProjects, useThreadProjection } from "../t3/src/state/entities";
import { resolveThreadRouteTarget } from "../t3/src/threadRoutes";
import { makeThreadRouter } from "../src/routes.tsx";
import { threadViewHost } from "./host.ts";
import { closeThreadPanel } from "./rightPanel.ts";

/** What a pane shows: a thread, or a project's draft until the server creates its thread. */
type ViewTarget =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "draft"; readonly projectId: string };

/**
 * A project's draft is the composer store's, minted by upstream's new-thread
 * handler and remembered here per project, in the page's localStorage beside
 * the store's own, so a reload or a later New Thread takes up the same draft.
 */
const draftKey = (environmentId: string, projectId: string) =>
  `pult-shell.draft:${environmentId}/${projectId}`;

/** The project's remembered draft while the composer store still holds it. */
function heldDraft(environmentId: string, projectId: string): DraftId | null {
  const draftId = localStorage.getItem(draftKey(environmentId, projectId)) as DraftId | null;
  const session =
    draftId === null ? null : useComposerDraftStore.getState().getDraftSession(draftId);
  return session !== null && session.projectId === projectId ? draftId : null;
}

/** Whether the server thread the view went to is the one the project's draft created. */
function isPromotion(environmentId: string, projectId: string, threadId: string): boolean {
  const draftId = localStorage.getItem(draftKey(environmentId, projectId)) as DraftId | null;
  if (draftId === null) return false;
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(draftId);
  return (
    session?.threadId === threadId ||
    session?.promotedTo?.threadId === threadId ||
    store.getDraftIdByRef(
      scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
    ) === draftId
  );
}

/** Where `target` is in the view's routes; a draft without a draft yet is the landing, which starts one. */
function targetPath(environmentId: string | null, target: ViewTarget): string {
  if (environmentId === null) return "/";
  // Encoded: the router decodes path parameters, and an id may itself hold an escape (`command%3Amcp…`).
  if (target.kind === "thread") {
    return `/${encodeURIComponent(environmentId)}/${encodeURIComponent(target.threadId)}`;
  }
  const draftId = heldDraft(environmentId, target.projectId);
  return draftId === null ? "/" : `/draft/${encodeURIComponent(draftId)}`;
}

/**
 * One mounted view and its target, which a draft's promotion turns into the
 * thread it created, live for the components that render by it.
 */
function makeMount(
  environmentId: string | null,
  initial: ViewTarget,
  onPromoted: (threadId: string) => void,
) {
  let target = initial;
  const listeners = new Set<() => void>();
  if (environmentId !== null && target.kind === "thread") {
    closeThreadPanel(environmentId, target.threadId);
  }
  return {
    environmentId,
    target: () => target,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    home: () => targetPath(environmentId, target),
    /** The draft became `threadId` on the server: the view is that thread's from now on. */
    promote(threadId: string) {
      if (target.kind !== "draft" || environmentId === null) return;
      localStorage.removeItem(draftKey(environmentId, target.projectId));
      target = { kind: "thread", threadId };
      closeThreadPanel(environmentId, threadId);
      for (const listener of listeners) listener();
      onPromoted(threadId);
    },
  };
}

type Mount = ReturnType<typeof makeMount>;

/**
 * Keeps the pane on its target. A draft follows itself into the thread it
 * creates. Any other thread the view went to opens in the shell, and so does
 * a draft of another project, or any draft reached from a thread (upstream's
 * New thread on branch, send and new), remembered as its project's draft
 * first so the shell's draft takes it up.
 */
function followNavigation(router: AnyRouter, mount: Mount) {
  const target = mount.target();
  const environmentId = mount.environmentId;
  const shown = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const goHome = () => void router.navigate({ to: mount.home(), replace: true });
  if (shown?.kind === "server") {
    const threadId = shown.threadRef.threadId;
    if (target.kind === "thread" && threadId === target.threadId) return;
    if (
      target.kind === "draft" &&
      environmentId !== null &&
      isPromotion(environmentId, target.projectId, threadId)
    ) {
      mount.promote(threadId);
      return;
    }
    threadViewHost().openThread(threadId);
    goHome();
    return;
  }
  if (shown?.kind === "draft") {
    const session = useComposerDraftStore.getState().getDraftSession(shown.draftId);
    if (session !== null && environmentId !== null) {
      localStorage.setItem(draftKey(environmentId, session.projectId), shown.draftId);
      if (target.kind === "draft" && session.projectId === target.projectId) {
        // The draft's details panel stays closed too, keyed by the thread id the draft holds.
        closeThreadPanel(environmentId, session.threadId);
        return;
      }
      threadViewHost().openDraft(session.projectId);
    }
    goHome();
    return;
  }
  if (router.state.location.pathname === mount.home()) return;
  toastManager.add({
    type: "info",
    title: "Not in Pult yet",
    description: "This page is part of T3 Code's own app.",
  });
  goHome();
}

/**
 * Reports the activity the mounted thread's projection knows to the shell:
 * each subagent of its roster that has a thread, and the thread itself when
 * it is a provider's native subagent, whose work is a runless turn the
 * thread list cannot see; each with when its work started. Live, on the
 * subscription the view holds anyway.
 */
function ActivityReporter({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  const projection =
    useThreadProjection(scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)))
      ?.projection ?? null;
  useEffect(() => {
    if (projection === null) return;
    const activity = projection.subagents.flatMap((subagent) =>
      subagent.childThreadId === null
        ? []
        : [
            {
              threadId: subagent.childThreadId,
              working: isOrchestrationV2WorkActive(subagent.status),
              workingSince:
                subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt),
            },
          ],
    );
    const own = deriveProviderSubagentStatus(projection);
    if (own !== null) {
      activity.push({
        threadId: ThreadId.make(threadId),
        working: isOrchestrationV2WorkActive(own.status),
        workingSince: own.startedAt,
      });
    }
    threadViewHost().reportActivity(activity);
  }, [projection, threadId]);
  return null;
}

function useTarget(mount: Mount): ViewTarget {
  return useSyncExternalStore(mount.subscribe, mount.target);
}

function makeRoot(mount: Mount) {
  function NavigationFollower() {
    const router = useRouter();
    useEffect(
      () => router.subscribe("onResolved", () => followNavigation(router, mount)),
      [router],
    );
    return null;
  }
  return function Root() {
    const target = useTarget(mount);
    return (
      <ToastProvider>
        <AnchoredToastProvider>
          <NavigationFollower />
          {mount.environmentId === null || target.kind !== "thread" ? null : (
            <ActivityReporter environmentId={mount.environmentId} threadId={target.threadId} />
          )}
          <ConfirmDialogHost />
          <CustomSnoozeDialogHost />
          <SidebarProvider defaultOpen={false}>
            <Outlet />
          </SidebarProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    );
  };
}

function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <main className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
      {children}
    </main>
  );
}

/** A draft without a draft yet starts one in its project, the way upstream's New Thread does. */
function DraftStart({
  environmentId,
  projectId,
}: {
  readonly environmentId: string;
  readonly projectId: string;
}) {
  const project = useProjects().find(
    (candidate) => candidate.id === projectId && candidate.environmentId === environmentId,
  );
  const handleNewThread = useNewThreadHandler();
  const started = useRef(false);
  useEffect(() => {
    if (project === undefined || started.current) return;
    started.current = true;
    void handleNewThread(
      scopeProjectRef(EnvironmentId.make(environmentId), ProjectId.make(projectId)),
      { replace: true },
    );
  }, [environmentId, handleNewThread, project, projectId]);
  return <Notice>{project === undefined ? "Loading the project…" : "Starting a thread…"}</Notice>;
}

function makeLanding(mount: Mount) {
  return function Landing() {
    const target = useTarget(mount);
    return target.kind === "draft" && mount.environmentId !== null ? (
      <DraftStart environmentId={mount.environmentId} projectId={target.projectId} />
    ) : (
      <Notice>This thread is not available. It may have been deleted.</Notice>
    );
  };
}

/**
 * Mounts the view above the pane's composer bar: the thread's settings
 * (model, reasoning, mode, attachments, the context window, a draft's
 * environment and branch) render there, out of the composer, which keeps
 * the message and its send button (`ComposerControlsSlot`).
 */
function mountView(
  element: HTMLElement,
  target: ViewTarget,
  onPromoted: (threadId: string) => void,
): { dispose(): void } {
  const mount = makeMount(threadViewHost().environmentId(), target, onPromoted);
  const router = makeThreadRouter({
    root: makeRoot(mount),
    landing: makeLanding(mount),
    initialPath: mount.home(),
  });
  element.classList.add("pult-thread-view");
  const main = document.createElement("div");
  main.className = "pult-thread-main";
  const bar = document.createElement("div");
  bar.className = "pult-composer-bar";
  element.append(main, bar);
  const root = createRoot(main);
  root.render(
    <StrictMode>
      <AppAtomRegistryProvider>
        <ComposerControlsSlot value={bar}>
          <RouterProvider router={router} />
        </ComposerControlsSlot>
      </AppAtomRegistryProvider>
    </StrictMode>,
  );
  return {
    dispose: () => {
      root.unmount();
      main.remove();
      bar.remove();
    },
  };
}

/** Renders the thread's turns and composer into `element` until disposed. */
export function mountThreadView(element: HTMLElement, threadId: string): { dispose(): void } {
  return mountView(element, { kind: "thread", threadId }, () => {});
}

/**
 * Renders the project's draft, upstream's composer for a new thread, into
 * `element` until disposed: the draft remembered for the project while the
 * composer store holds it, else a new one. When the server creates its
 * thread, the view stays mounted as that thread's, and `onPromoted` names it.
 */
export function mountDraftView(
  element: HTMLElement,
  projectId: string,
  onPromoted: (threadId: string) => void,
): { dispose(): void } {
  return mountView(element, { kind: "draft", projectId }, onPromoted);
}
