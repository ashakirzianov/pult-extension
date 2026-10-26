/** How a file changed, as the server's file contents RPC names it. */
export type ChangeType = "change" | "rename-pure" | "rename-changed" | "new" | "deleted";

export interface PatchFile {
  /** The file's path after the change, relative to the repository. */
  readonly path: string;
  /** Its path before a rename; null otherwise. */
  readonly previousPath: string | null;
  readonly changeType: ChangeType;
}

/**
 * The files of a unified diff and how each changed, read from the headers
 * git writes (`diff --git`, `new file mode`, `deleted file mode`, `rename
 * from` and `rename to`) and from whether hunks follow: a rename without
 * hunks is pure. A truncated patch names only the files it reached.
 */
export function patchFiles(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  for (const block of patch.split(/^(?=diff --git )/m)) {
    const lines = block.split("\n");
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[0] ?? "");
    if (header === null) continue;
    let oldPath = header[1] ?? "";
    let newPath = header[2] ?? "";
    let kind: "change" | "new" | "deleted" | "rename" = "change";
    let hunks = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith("new file mode")) kind = "new";
      else if (line.startsWith("deleted file mode")) kind = "deleted";
      else if (line.startsWith("rename from ")) {
        kind = "rename";
        oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) newPath = line.slice("rename to ".length);
      else if (line.startsWith("@@") || line.startsWith("Binary files")) hunks = true;
    }
    files.push({
      path: newPath,
      previousPath: kind === "rename" ? oldPath : null,
      changeType: kind === "rename" ? (hunks ? "rename-changed" : "rename-pure") : kind,
    });
  }
  return files;
}
