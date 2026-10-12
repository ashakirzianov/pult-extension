import { describe, expect, it } from "vite-plus/test";

import { draftUri, parseThreadUri, threadUri, titleSegment } from "./uri.ts";

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
