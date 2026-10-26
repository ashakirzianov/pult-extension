// The app around upstream's thread view in Pult's shell: one thread per pane,
// on the shell's connection. A navigation to another thread opens it in the
// shell; drafts and upstream's own pages are not part of a thread pane yet.
import { type AnyRouter, Outlet, RouterProvider, useRouter } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveProviderSubagentStatus } from "@t3tools/client-runtime/state/thread-execution";
import { EnvironmentId, isOrchestrationV2WorkActive, ThreadId } from "@t3tools/contracts";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { ConfirmDialogHost } from "../t3/src/components/ConfirmDialogHost";
import { CustomSnoozeDialogHost } from "../t3/src/components/CustomSnoozeDialog";
import { SidebarProvider } from "../t3/src/components/ui/sidebar";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../t3/src/components/ui/toast";
import { AppAtomRegistryProvider } from "../t3/src/rpc/atomRegistry";
import { useThreadProjection } from "../t3/src/state/entities";
import { resolveThreadRouteTarget } from "../t3/src/threadRoutes";
import { makeThreadRouter } from "../src/routes.tsx";
import { threadViewHost } from "./host.ts";
import { closeThreadPanel } from "./rightPanel.ts";

/** Keeps the pane on its thread, and hands the shell any other thread the view went to. */
function followNavigation(router: AnyRouter, home: string, threadId: string) {
  const shown = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  if (shown?.kind === "server") {
    if (shown.threadRef.threadId !== threadId) {
      threadViewHost().openThread(shown.threadRef.threadId);
      void router.navigate({ to: home, replace: true });
    }
    return;
  }
  if (router.state.location.pathname === home) return;
  toastManager.add({
    type: "info",
    title: "Not in Pult yet",
    description:
      shown?.kind === "draft"
        ? "New threads start from T3 Code's own app for now."
        : "This page is part of T3 Code's own app.",
  });
  void router.navigate({ to: home, replace: true });
}

/**
 * Reports the activity the mounted thread's projection knows to the shell:
 * each subagent of its roster that has a thread, and the thread itself when
 * it is a provider's native subagent, whose work is a runless turn the
 * thread list cannot see. Live, on the subscription the view holds anyway.
 */
function ActivityReporter({ environmentId, threadId }: { environmentId: string; threadId: string }) {
  const projection =
    useThreadProjection(scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)))?.projection ?? null;
  useEffect(() => {
    if (projection === null) return;
    const activity = projection.subagents.flatMap((subagent) =>
      subagent.childThreadId === null ? [] : [{ threadId: subagent.childThreadId, working: isOrchestrationV2WorkActive(subagent.status) }],
    );
    const own = deriveProviderSubagentStatus(projection);
    if (own !== null) activity.push({ threadId: ThreadId.make(threadId), working: isOrchestrationV2WorkActive(own.status) });
    threadViewHost().reportActivity(activity);
  }, [projection, threadId]);
  return null;
}

function makeRoot(home: string, environmentId: string | null, threadId: string) {
  function NavigationFollower() {
    const router = useRouter();
    useEffect(
      () => router.subscribe("onResolved", () => followNavigation(router, home, threadId)),
      [router],
    );
    return null;
  }
  return function Root() {
    return (
      <ToastProvider>
        <AnchoredToastProvider>
          <NavigationFollower />
          {environmentId === null ? null : <ActivityReporter environmentId={environmentId} threadId={threadId} />}
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

function Landing() {
  return (
    <main className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
      This thread is not available. It may have been deleted.
    </main>
  );
}

/** Renders the thread's turns and composer into `element` until disposed. */
export function mountThreadView(element: HTMLElement, threadId: string): { dispose(): void } {
  const environmentId = threadViewHost().environmentId();
  if (environmentId !== null) closeThreadPanel(environmentId, threadId);
  // Encoded: the router decodes path parameters, and an id may itself hold an escape (`command%3Amcp…`).
  const home =
    environmentId === null ? "/" : `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  const router = makeThreadRouter({
    root: makeRoot(home, environmentId, threadId),
    landing: Landing,
    initialPath: home,
  });
  element.classList.add("pult-thread-view");
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>
    </StrictMode>,
  );
  return { dispose: () => root.unmount() };
}
