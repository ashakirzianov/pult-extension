// The app around upstream's thread view, in place of the fork's root: the
// thread routes (`routes.tsx`), the providers and dialog hosts the view
// expects, and the tab's own rules. A tab holds
// one thread; a draft tab follows its draft into the thread it creates, and a
// navigation to any other thread or a new one goes to its own tab.
import "../t3/src/index.css";
import "./vscode.css";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { type AnyRouter, Outlet, RouterProvider, useRouter } from "@tanstack/react-router";
import { StrictMode, useEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { ConfirmDialogHost } from "../t3/src/components/ConfirmDialogHost";
import { CustomSnoozeDialogHost } from "../t3/src/components/CustomSnoozeDialog";
import { SidebarProvider } from "../t3/src/components/ui/sidebar";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../t3/src/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "../t3/src/composerDraftStore";
import { useNewThreadHandler } from "../t3/src/hooks/useHandleNewThread";
import { AppAtomRegistryProvider } from "../t3/src/rpc/atomRegistry";
import { useProjects } from "../t3/src/state/entities";
import { resolveThreadRouteTarget } from "../t3/src/threadRoutes";
import { TAB_DRAFT_KEY_PREFIX } from "../../src/threads/protocol.ts";
import { post } from "./bridge.ts";
import { makeThreadRouter } from "./routes.tsx";
import { session } from "./session.ts";
import { installTestHooks } from "./testHooks.ts";

// A draft tab's id is the tab's; the draft it holds is the composer store's,
// minted by upstream's new-thread handler and remembered here.
function heldDraft(tabDraftId: string): DraftId | null {
  const draftId = localStorage.getItem(TAB_DRAFT_KEY_PREFIX + tabDraftId) as DraftId | null;
  return draftId !== null && useComposerDraftStore.getState().getDraftSession(draftId) !== null
    ? draftId
    : null;
}

/** Where the tab's own thread is in the view's routes. */
function tabPath(): string {
  const { environment, target } = session();
  if (target.kind === "thread") return `/${environment.environmentId}/${target.threadId}`;
  const draftId = heldDraft(target.draftId);
  return draftId === null ? "/" : `/draft/${draftId}`;
}

function returnToTab(router: AnyRouter) {
  void router.navigate({ to: tabPath(), replace: true });
}

/** Keeps the view on the tab's thread, and tells the host where the view went instead. */
function followNavigation(router: AnyRouter) {
  const tab = session().target;
  const params = router.state.matches.at(-1)?.params ?? {};
  const shown = resolveThreadRouteTarget(params);
  if (shown?.kind === "draft") {
    if (tab.kind === "draft") {
      localStorage.setItem(TAB_DRAFT_KEY_PREFIX + tab.draftId, shown.draftId);
      return;
    }
    const draft = useComposerDraftStore.getState().getDraftSession(shown.draftId);
    if (draft !== null) post({ type: "newThread", projectId: draft.projectId });
    returnToTab(router);
    return;
  }
  if (shown?.kind === "server") {
    const threadId = shown.threadRef.threadId;
    if (tab.kind === "draft") post({ type: "promoted", threadId });
    else if (threadId !== tab.threadId) {
      post({ type: "open", threadId });
      returnToTab(router);
    }
    return;
  }
  // Upstream's own pages, such as settings, are not part of a thread tab.
  if (router.state.location.pathname === "/") return;
  toastManager.add({
    type: "info",
    title: "Not in Pult",
    description: "This page is part of T3 Code's own app.",
  });
  returnToTab(router);
}

function NavigationFollower() {
  const router = useRouter();
  useEffect(() => router.subscribe("onResolved", () => followNavigation(router)), [router]);
  return null;
}

function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <main className="flex h-svh items-center justify-center p-6 text-sm text-muted-foreground">
      {children}
    </main>
  );
}

/** A draft tab without a draft yet starts one in its project, the way upstream's New Thread does. */
function DraftStart({ projectId }: { readonly projectId: string }) {
  const environmentId = session().environment.environmentId;
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

function Landing() {
  const target = session().target;
  return target.kind === "draft" ? (
    <DraftStart projectId={target.projectId} />
  ) : (
    <Notice>This thread is not available. It may have been deleted.</Notice>
  );
}

function Root() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <NavigationFollower />
        <ConfirmDialogHost />
        <CustomSnoozeDialogHost />
        <SidebarProvider defaultOpen={false}>
          <Outlet />
        </SidebarProvider>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

export function mountThreadApp(root: HTMLElement) {
  const router = makeThreadRouter({ root: Root, landing: Landing, initialPath: tabPath() });
  if (session().development) installTestHooks(router);
  createRoot(root).render(
    <StrictMode>
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>
    </StrictMode>,
  );
}
