# Decisions

What the code cannot say about itself: decisions in force, grouped by area.

## Repository

### extension-repo
**Pult's VS Code extension is its own repository, `pult-extension`, which vendors the protocol packages from T3 Code Extensible at the same PIN as Pult.** 2026-10-07. The extension has its own release cadence, as a VSIX, and no coupling to the desktop and web client builds. It shares Pult's PIN because both of Pult's clients speak the same server version, and the track bumps once. Anton's ruling. *Rejected:* an app inside the `pult` monorepo (the default proposed on `pult/vscode-extension`). *See:* `pult/vscode-extension`.

## Extension

### web-extension
**The extension is a web extension, with a `browser` entry only, so `ssh` and `tailscale` are not vendored and an environment the Pult desktop reaches over SSH is out of its reach.** 2026-10-07. RFC 1 keeps web open while it costs nothing and drops it the day a concrete UX needs Node. *Rejected:* a Node extension now. *See:* `../pult/docs/pult/rfc-1.md`, `pult/vscode-extension`.
