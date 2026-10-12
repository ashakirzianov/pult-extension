# Decisions

What the code cannot say about itself: decisions in force, grouped by area.

## Repository

### extension-repo
**Pult's VS Code extension is its own repository, `pult-extension`, which vendors the protocol packages from T3 Code Extensible at the same PIN as Pult.** 2026-10-07. The extension has its own release cadence, as a VSIX, and no coupling to the desktop and web client builds. It shares Pult's PIN because both of Pult's clients speak the same server version, and the track bumps once. Anton's ruling. *Rejected:* an app inside the `pult` monorepo (the default proposed on `pult/vscode-extension`). *See:* `pult/vscode-extension`.

## Extension

### web-extension
**The extension is a web extension, with a `browser` entry only, so `ssh` and `tailscale` are not vendored and an environment the Pult desktop reaches over SSH is out of its reach.** 2026-10-07. RFC 1 keeps web open while it costs nothing and drops it the day a concrete UX needs Node. *Rejected:* a Node extension now. *See:* `../pult/docs/pult/rfc-1.md`, `pult/vscode-extension`.

### connection-owner
**The extension host owns the one WebSocket per window and connects only after an HTTP probe (the environment descriptor, then a WebSocket ticket) succeeds; webviews reach the server only through the host's socket.** 2026-10-07. Webviews are a separate origin under a CSP and the ticket call is cross-origin, so a webview-owned connection would fail on exactly the servers that restrict origins, and a WebSocket-only probe hides that failure since the upgrade has no origin check. *Rejected:* a connection per webview; a bare WebSocket probe. *See:* `pult/vscode-connect`.

### pult-uri
**A `pult:` URI's authority is the environment id and its path the host's absolute path; workspace folders are project and worktree roots, and an unbound window binds to the environment its `pult:` folders name.** 2026-10-07. A thread's citations are host paths against its cwd and worktrees sit outside the project root, so project-relative paths would not resolve them; the authority keeps URIs unambiguous in recent files, workspace files and restored tabs across windows, and lets a saved `.code-workspace` reopen an environment. Anton's ruling. *Rejected:* project id as authority with project-relative paths; one window per project. *See:* `pult/virtual-workspace`.

### capability-gated-rpcs
**A vendored RPC that stock T3 Code servers lack is called only when the server advertises its feature flag, and every such feature has a named stock-server behaviour.** 2026-10-07. The PIN follows the fork, so the contracts know calls stock servers do not have, while RFC 1 targets stock servers; a flag check per feature is the house pattern (`scratchWorkspaceRoot`). *Rejected:* a minimum server version; emulating missing mutations client-side. *See:* `pult/virtual-workspace`, `pult/filesystem-rpcs`.
