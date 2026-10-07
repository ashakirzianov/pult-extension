# Decisions

What the code cannot say about itself: decisions in force, grouped by area.

## Repository

### extension-repo
**Pult's VS Code extension is its own repository, `pult-extension`, which vendors the protocol packages from T3 Code Extensible at the same PIN as Pult.** 2026-10-07. The extension has its own release cadence, as a VSIX, and no coupling to the desktop and web client builds. It shares Pult's PIN because both of Pult's clients speak the same server version, and the track bumps once. Anton's ruling. *Rejected:* an app inside the `pult` monorepo (the default proposed on `pult/vscode-extension`). *See:* `pult/vscode-extension`.

## Extension

### web-extension
**The extension is a web extension, with a `browser` entry only, so `ssh` and `tailscale` are not vendored and an environment the Pult desktop reaches over SSH is out of its reach.** 2026-10-07. RFC 1 keeps web open while it costs nothing and drops it the day a concrete UX needs Node. *Rejected:* a Node extension now. *See:* `../pult/docs/pult/rfc-1.md`, `pult/vscode-extension`.

### environment-binding
**A window binds to one environment through a `workspaceState` entry holding the environment id; the environment catalog is `globalState` and the folders of the virtual workspace must match the binding.** 2026-10-07. VS Code has no per-window state, and a workspace memento is the nearest thing, present even in an empty window; one binding per window is the "one window per environment" rule in a form the code can check. Anton's ruling. *Rejected:* a global binding; deriving the environment from the workspace folders alone. *See:* `pult/vscode-connect`.

### credential-store
**The extension pairs with an environment itself, and keeps the bearer in `SecretStorage` keyed by environment id, shared by every window bound to that environment.** 2026-10-07. Each client is its own session, so the extension never reads the Pult desktop's credential; `SecretStorage` is encrypted on desktop and scoped per browser profile on the web, and keying by environment makes pairing a once-per-environment act. Anton's ruling. *Rejected:* the credential in `workspaceState`; the server URL as a setting. *See:* `pult/vscode-connect`.
