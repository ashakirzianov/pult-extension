import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2ThreadShell } from "../../../vendor/t3code/packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  draftUri,
  followedUri,
  parseThreadUri,
  type ThreadResource,
  type TitledThread,
  threadUri,
  titleSegment,
} from "./uri.ts";

describe("thread URIs", () => {
  it("round-trips a thread, its title only the label", () => {
    const uri = threadUri("env-1", "thread-9", "Fix the login flow");
    expect(uri.path).toBe("/thread-9/Fix the login flow");
    expect(parseThreadUri(uri)).toEqual({
      environmentId: "env-1",
      target: { kind: "thread", threadId: "thread-9" },
      title: "Fix the login flow",
    });
  });

  it("keeps a slash in a title from splitting the path", () => {
    const uri = threadUri("env-1", "thread-9", "a/b  and\nc");
    expect(uri.path).toBe("/thread-9/a∕b and c");
    expect(parseThreadUri(uri)?.target).toEqual({ kind: "thread", threadId: "thread-9" });
  });

  it("names an untitled thread", () => {
    expect(titleSegment("  ")).toBe("Untitled thread");
  });

  it("round-trips a draft with its project", () => {
    const uri = draftUri("env-1", "draft-2", "project-3");
    expect(uri.path).toBe("/draft/draft-2/New Thread");
    expect(parseThreadUri(uri)).toEqual({
      environmentId: "env-1",
      target: { kind: "draft", draftId: "draft-2", projectId: "project-3" },
      title: "New Thread",
    });
  });

  it("refuses what is not a thread tab", () => {
    const base = { scheme: "pult-thread", authority: "env-1", query: "" };
    expect(parseThreadUri({ ...base, scheme: "file", path: "/t/title" })).toBeNull();
    expect(parseThreadUri({ ...base, authority: "", path: "/t/title" })).toBeNull();
    expect(parseThreadUri({ ...base, path: "/t" })).toBeNull();
    expect(parseThreadUri({ ...base, path: "/t/title/extra" })).toBeNull();
    expect(parseThreadUri({ ...base, path: "/draft/d/New Thread" })).toBeNull();
  });
});

describe("followedUri", () => {
  const titled = (title: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
    presentThreadShell(EnvironmentId.make("env-1"), {
      ...v2ThreadShell,
      id: ThreadId.make("thread-9"),
      title,
      latestRunId: RunId.make("run"),
      status: "running",
      ...overrides,
    });
  const generating = {
    titleRegeneration: {
      requestId: CommandId.make("command"),
      startedAt: DateTime.makeUnsafe(Date.now()),
    },
  };
  const draft = parseThreadUri(draftUri("env-1", "draft-1", "project-1"))!;
  const follow = (
    resource: ThreadResource,
    thread: TitledThread | undefined,
    options: { readonly promotedTo?: string; readonly shown?: boolean } = {},
  ) =>
    followedUri({
      resource,
      promotedTo: options.promotedTo ?? null,
      thread: () => thread,
      shown: options.shown ?? false,
    })?.path;

  it("moves a thread tab whose title changed, and only then", () => {
    const tab = parseThreadUri(threadUri("env-1", "thread-9", "Fix the login"))!;
    expect(follow(tab, titled("Fix the login flow"))).toBe("/thread-9/Fix the login flow");
    expect(follow(tab, titled("Fix the login"))).toBeUndefined();
    expect(follow(tab, undefined)).toBeUndefined();
  });

  it("keeps a draft's tab until its thread has the generated title, so it moves once", () => {
    const promoted = { promotedTo: "thread-9" };
    expect(follow(draft, undefined, promoted)).toBeUndefined();
    expect(follow(draft, titled("Fix the", { latestRunId: null }), promoted)).toBeUndefined();
    expect(follow(draft, titled("Fix the", generating), promoted)).toBeUndefined();
    expect(follow(draft, titled("Fix the login flow"), promoted)).toBe(
      "/thread-9/Fix the login flow",
    );
    expect(follow(draft, titled("Fix the login flow"))).toBeUndefined();
  });

  it("moves a draft's tab that was just shown, whose page loads again anyway", () => {
    const shown = { promotedTo: "thread-9", shown: true };
    expect(follow(draft, titled("Fix the", generating), shown)).toBe("/thread-9/Fix the");
    expect(follow(draft, undefined, shown)).toBe("/thread-9/Untitled thread");
  });
});
