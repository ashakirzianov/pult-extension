// The thread routes the view navigates between, in place of the fork's router
// (`t3/src/routes/`), shared by the thread tab's app (`ThreadApp.tsx`) and the
// shell's in-process view (`../shell/ThreadView.tsx`): each brings its root,
// with the providers and its own rules, and its landing page.
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ThreadRouteView } from "../t3/src/components/ThreadRouteView";
import { resolveThreadRouteTarget } from "../t3/src/threadRoutes";

function ThreadLayout() {
  // Both thread routes render here, as upstream's `_chat` layout does, so a
  // draft's promotion keeps one ChatView mounted across the route swap.
  const target = useParams({ strict: false, select: resolveThreadRouteTarget });
  return target ? <ThreadRouteView target={target} /> : <Outlet />;
}

/** The search parameters the thread view sets on those pages, which the app never reads. */
type ElsewhereSearch = Readonly<Record<string, unknown>>;

const anySearch = (search: Record<string, unknown>): ElsewhereSearch => search;

/** A router over the thread routes, in memory, starting at `initialPath`. */
export function makeThreadRouter(input: {
  readonly root: () => ReactNode;
  readonly landing: () => ReactNode;
  readonly initialPath: string;
}) {
  const rootRoute = createRootRoute({ component: input.root, notFoundComponent: () => null });
  const threadLayout = createRoute({
    getParentRoute: () => rootRoute,
    id: "_chat",
    component: ThreadLayout,
  });
  const landingRoute = createRoute({
    getParentRoute: () => threadLayout,
    path: "/",
    component: input.landing,
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
  // this router; the app sends the view back from them.
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
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [input.initialPath] }),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeThreadRouter>;
  }
}
