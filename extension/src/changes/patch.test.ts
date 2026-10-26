import { describe, expect, it } from "vite-plus/test";

import { patchFiles } from "./patch.ts";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export const fresh = true;
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const old = true;
diff --git a/src/before.ts b/src/after.ts
similarity index 100%
rename from src/before.ts
rename to src/after.ts
diff --git a/src/moved.ts b/src/lib/moved.ts
similarity index 90%
rename from src/moved.ts
rename to src/lib/moved.ts
index 5555555..6666666 100644
--- a/src/moved.ts
+++ b/src/lib/moved.ts
@@ -1 +1 @@
-export const moved = 1;
+export const moved = 2;
diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ
`;

describe("patchFiles", () => {
  it("reads each file's change from git's headers", () => {
    expect(patchFiles(PATCH)).toEqual([
      { path: "src/a.ts", previousPath: null, changeType: "change" },
      { path: "src/new.ts", previousPath: null, changeType: "new" },
      { path: "src/old.ts", previousPath: null, changeType: "deleted" },
      { path: "src/after.ts", previousPath: "src/before.ts", changeType: "rename-pure" },
      { path: "src/lib/moved.ts", previousPath: "src/moved.ts", changeType: "rename-changed" },
      { path: "logo.png", previousPath: null, changeType: "change" },
    ]);
  });

  it("reads nothing from an empty patch", () => {
    expect(patchFiles("")).toEqual([]);
  });
});
