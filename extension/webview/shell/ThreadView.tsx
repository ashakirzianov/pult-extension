// The app around upstream's thread view in Pult's shell: one thread per pane,
// on the shell's connection. A navigation to another thread opens it in the
// shell; drafts and upstream's own pages are not part of a thread pane yet.
import { type AnyRouter, Outlet, RouterProvider, useRouter } from "@tanstack/react-router";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { ConfirmDialogHost } from "../t3/src/components/ConfirmDialogHost";
import { CustomSnoozeDialogHost } from "../t3/src/components/CustomSnoozeDialog";
import { SidebarProvider } from "../t3/src/components/ui/sidebar";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../t3/src/components/ui/toast";
import { AppAtomRegistryProvider } from "../t3/src/rpc/atomRegistry";
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

function makeRoot(home: string, threadId: string) {
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
    root: makeRoot(home, threadId),
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
