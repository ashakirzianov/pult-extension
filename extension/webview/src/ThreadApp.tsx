// The app around upstream's thread view, in place of the fork's router and
// root (`t3/src/routes/`): the thread routes the view navigates between, the
// providers and dialog hosts it expects, and the tab's own rules. A tab holds
// one thread; a draft tab follows its draft into the thread it creates, and a
// navigation to any other thread or a new one goes to its own tab.
import "../t3/src/index.css";
import "./vscode.css";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import { StrictMode, useEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { ConfirmDialogHost } from "../t3/src/components/ConfirmDialogHost";
import { CustomSnoozeDialogHost } from "../t3/src/components/CustomSnoozeDialog";
import { ThreadRouteView } from "../t3/src/components/ThreadRouteView";
import { SidebarProvider } from "../t3/src/components/ui/sidebar";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../t3/src/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "../t3/src/composerDraftStore";
import { useNewThreadHandler } from "../t3/src/hooks/useHandleNewThread";
import { AppAtomRegistryProvider } from "../t3/src/rpc/atomRegistry";
import { useProjects } from "../t3/src/state/entities";
import { resolveThreadRouteTarget } from "../t3/src/threadRoutes";
import { TAB_DRAFT_KEY_PREFIX } from "../../src/threads/protocol.ts";
import { post } from "./bridge.ts";
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

function ThreadLayout() {
  // Both thread routes render here, as upstream's `_chat` layout does, so a
  // draft's promotion keeps one ChatView mounted across the route swap.
  const target = useParams({ strict: false, select: resolveThreadRouteTarget });
  return target ? <ThreadRouteView target={target} /> : <Outlet />;
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

/** The search parameters the thread view sets on those pages, which the tab never reads. */
type ElsewhereSearch = Readonly<Record<string, unknown>>;

const anySearch = (search: Record<string, unknown>): ElsewhereSearch => search;

const rootRoute = createRootRoute({ component: Root, notFoundComponent: () => null });
const threadLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "_chat",
  component: ThreadLayout,
});
const landingRoute = createRoute({
  getParentRoute: () => threadLayout,
  path: "/",
  component: Landing,
});
const threadRoute = createRoute({
  getParentRoute: () => threadLayout,
  path: "$environmentId/$threadId",
  component: () => null,
});
const draftRoute = createRoute({
  getParentRoute: () => threadLayout,
  path: "draft/$draftId",
  component: () => null,
});

// The fork's pages the thread view links to, so the links typecheck against
// this router; landing on one sends the view back (`followNavigation`).
const pullRequestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "pull-requests",
  validateSearch: anySearch,
});
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "projects/$projectKey",
});
const settingsRoutes = (
  ["connections", "providers", "scheduled-tasks", "source-control"] as const
).map((page) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: `settings/${page}`,
    validateSearch: anySearch,
  }),
);

const routeTree = rootRoute.addChildren([
  threadLayout.addChildren([landingRoute, threadRoute, draftRoute]),
  pullRequestsRoute,
  projectRoute,
  ...settingsRoutes,
]);

function makeRouter() {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [tabPath()] }),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}

export function mountThreadApp(root: HTMLElement) {
  const router = makeRouter();
  if (session().development) installTestHooks(router);
  createRoot(root).render(
    <StrictMode>
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>
    </StrictMode>,
  );
}
