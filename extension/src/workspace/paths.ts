/**
 * Paths of `pult:` URIs. A URI's authority is the environment id and its path
 * the host's absolute path with forward slashes: `/Users/anton/x.ts` as is, a
 * Windows `C:\Users\x.ts` as `/c:/Users/x.ts` (`pult/decisions`, `pult-uri`).
 * Workspace folders are project and worktree roots, held as URI paths.
 */
export const PULT_SCHEME = "pult";

/**
 * A host path as a `pult:` URI path. A drive letter is lowercased, as VS Code
 * writes it in any URI it saves, so a restored folder or tab still matches.
 */
export function toUriPath(hostPath: string): string {
  const path = /^[A-Za-z]:([\\/]|$)/.test(hostPath)
    ? `/${hostPath.charAt(0).toLowerCase()}${hostPath.slice(1).replaceAll("\\", "/")}`
    : hostPath;
  return path.length > 1 && path.endsWith("/") && !/^\/[A-Za-z]:\/$/.test(path)
    ? path.slice(0, -1)
    : path;
}

/** A `pult:` URI path as the host path the server takes; Windows paths keep forward slashes. */
export function toHostPath(uriPath: string): string {
  return /^\/[A-Za-z]:(\/|$)/.test(uriPath) ? uriPath.slice(1) : uriPath;
}

/** `path` relative to `root`: `""` for the root itself, undefined outside it. */
export function relativeTo(root: string, path: string): string | undefined {
  if (path === root) return "";
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : undefined;
}

export interface Located {
  readonly root: string;
  readonly relativePath: string;
}

/** The innermost of `roots` holding `path`, and the path relative to it. */
export function locate(roots: Iterable<string>, path: string): Located | undefined {
  let found: Located | undefined;
  for (const root of roots) {
    const relativePath = relativeTo(root, path);
    if (relativePath === undefined) continue;
    if (found === undefined || root.length > found.root.length) found = { root, relativePath };
  }
  return found;
}

export function joinPath(root: string, relativePath: string): string {
  if (relativePath === "") return root;
  return root.endsWith("/") ? `${root}${relativePath}` : `${root}/${relativePath}`;
}

/** The parent of a root-relative path, `""` for an entry at the root. */
export function parentOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Whether a URI authority names an environment. VS Code lowercases authorities
 * when it writes a URI out, so a restored folder may differ in case.
 */
export function namesEnvironment(authority: string, environmentId: string): boolean {
  return authority.toLowerCase() === environmentId.toLowerCase();
}
