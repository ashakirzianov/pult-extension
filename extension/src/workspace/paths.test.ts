import { describe, expect, it } from "vite-plus/test";

import { locate, namesEnvironment, relativeTo, toHostPath, toUriPath } from "./paths.ts";

describe("pult: paths", () => {
  it("carries POSIX and Windows host paths", () => {
    expect(toUriPath("/Users/anton/repos/pult/")).toBe("/Users/anton/repos/pult");
    expect(toHostPath(toUriPath("/Users/anton/x.ts"))).toBe("/Users/anton/x.ts");
    // VS Code lowercases a drive letter in every URI it saves.
    expect(toUriPath("C:\\Users\\anton\\x.ts")).toBe("/c:/Users/anton/x.ts");
    expect(toHostPath("/c:/Users/anton/x.ts")).toBe("c:/Users/anton/x.ts");
    expect(toUriPath("C:\\")).toBe("/c:/");
  });

  it("locates a path in the innermost root, never in a sibling sharing a prefix", () => {
    const roots = ["/repos/pult", "/repos/pult/vendor", "/repos/pult-extension"];
    expect(locate(roots, "/repos/pult/vendor/x.ts")).toEqual({
      root: "/repos/pult/vendor",
      relativePath: "x.ts",
    });
    expect(locate(roots, "/repos/pult-extension/a.ts")?.root).toBe("/repos/pult-extension");
    expect(locate(roots, "/repos/pult")).toEqual({ root: "/repos/pult", relativePath: "" });
    expect(locate(roots, "/repos/other/a.ts")).toBeUndefined();
    expect(relativeTo("/", "/etc/hosts")).toBe("etc/hosts");
  });

  it("matches an authority VS Code lowercased", () => {
    expect(namesEnvironment("3f2a-ab", "3F2A-AB")).toBe(true);
    expect(namesEnvironment("3f2a-ab", "3f2a-ac")).toBe(false);
  });
});
