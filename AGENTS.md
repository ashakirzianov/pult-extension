---
track: pult
label: repo:pult-extension
---

# Pult extension

This repo is **Pult's VS Code extension**, step 1 of RFC 1, and a repo of the **Pult track** (xaxis `pult/about`). The extension attaches to a running T3 Code server over its WebSocket and HTTP protocol, typed by the vendored packages, and ships as a VSIX. The server is not here: a server-side need goes to the fork (`pult/decisions`, `server-side-home`). The track's RFCs, design principles and decisions live in xaxis under `pult/`. Cross-track conventions live in `../axis/AGENTS.md`.

- Read xaxis `pult/rfc-0` (human-written, never edited by agents) before anything else, then `pult/rfc-1`, the current direction.
- The track's decisions are xaxis `pult/decisions`: one log for its three repos, grouped by area, this repo's under `pult-extension: Repository` and Extension. Record a new one there, in the entry shape of `../axis/workflow/global-agents.md`.
- Commits are small and semantically scoped, one logical unit each, with conventional titles. `origin` is `github.com/ashakirzianov/pult-extension`.
- Licence: upstream's MIT text stays.

## Review posture

**High-level.** Anton reviews direction, interfaces and module boundaries (the RFCs, `pult/decisions`, the seams with the server and the vendored packages), not implementation. Agents commit on their own and surface design deltas introduced during implementation rather than landing them silently. **Never push unless asked:** pushing is Anton's call while the GitHub repo is not created.

## Glossary

- **you** means the agent reading this file and changing the extension.
- **user** means Anton, using Pult to direct coding agents.
- **agent** means a coding agent run inside a T3 Code thread. Depending on context, that may include you.
- **environment** means one running server and the machine, filesystem, credentials and state it owns. The extension runs no server; it attaches to one.
- **project**, **thread**, **turn** are the server's: a workspace record rooted at a directory, the durable conversation for a project, one user-to-agent cycle.
- **T3 home** means the server's base data directory: `~/.t3` for the live server.

## Where code lives

- `extension/` - the extension: the manifest (`package.json`, whose `contributes` are the commands, the Activity Bar container and its views, and the `pult.thread` custom editor), `src/extension.ts` as the entry, `src/connection/` the window's connection (the environment catalog and the window binding, the HTTP probe, the vendored runtime's platform layer and the service over it, and `shell.ts`, the connection of Pult's own shell, which the extension uses instead when `vscode.env.appName` is `Pult`), `src/workspace/` the virtual workspace (the `pult:` file system provider over the project RPCs, its folder binding, and Open Project and the search commands), `src/threads/` the threads (the picker, the thread tabs' custom editor, their status decorations and commands, and the socket hub that shares the window's socket with the tabs), `src/changes/` the changes view (VS Code's Source Control view over the selected thread's project from the server's review calls, its two groups the server's diff sources, each change VS Code's diff editor with the old side from a `pult-diff:` content provider; in Pult's shell it follows the shell's selection and takes the thread view's "Open diff"), `media/`, and `test/load.ts`, the headless load. esbuild bundles it into `dist/web/extension.js`.
- `extension/webview/` - the thread bundle, the page a thread tab loads: `src/` is ours (the entry, the app around the thread view, the bridge to the host, and the stubs), `t3/` the tracked copy of the fork's thread view, `stubs.ts` the upstream modules our files replace. Vite builds it as the fork builds its web app (the React Compiler, Tailwind) into `dist/webview/`. `shell/` is the same view for Pult's own shell, mounted in-process in its thread pane over the shell's connection: `vite.config.ts --mode shell` builds it into `dist/shell/` as a module that imports React, Effect and the vendored packages from the shell's page, with `SHELL_STUBS` for its stubs.
- `vendor/t3code/packages` - `contracts`, `client-runtime`, `shared`, and the workspace packages `client-runtime` depends on (`source-control-*`, `provider-core`); `vendor/t3code/patches` - the fork's patches to the packages this repo installs, applied through `pnpm-workspace.yaml`, whose `catalog`, `overrides`, `packageExtensions` and `patchedDependencies` blocks `vendor.ts` writes from the fork's (never edit those blocks either). All of it is copied verbatim from T3 Code Extensible at the commit in `vendor/t3code/PIN`. Import `client-runtime` by subpath; it has no root export.
- `scripts/` - `vendor.ts` and its test, the vendoring; `merge.ts` and its test, the tracked copy's merge; `checkout.ts`, which finds the fork's checkout; and `testWeb.ts`, the headless load's runner.
- `docs/` - standing notes and runbooks: `development.md`, running against a dev server.

**Never edit `vendor/`.** A bump is a new PIN, `pnpm vendor:sync`, `pnpm i`, `pnpm vendor:merge`, and fixing what the types say; `pnpm vendor:check` fails on drift. The fork's checkout is `PULT_T3CODE_CHECKOUT` (environment or `.env`), by default `~/repos/t3code-extensible`. The PIN is Pult's: bump it here and in Pult together (`pult/decisions`, `extension-repo`).

**Edit `extension/webview/t3/` sparingly.** It is the fork's `apps/web` at the commit in its `UPSTREAM`, as far as the entry in `webview/src/` reaches it, imports of types included (`pult/decisions`, `thread-view-source`). What a thread tab needs from the app around the view goes in files of ours: `webview/src/` mounts upstream's components, and a stub in `webview/stubs.ts` replaces a whole upstream module. Edit a copied file only when neither can do it, and list the edit and its reason in `t3/EDITS.md`. `pnpm vendor:merge` brings the copy to the PIN: it merges upstream's change into each copied file three ways, leaving conflict markers for you, adds the files the entry now reaches and drops unedited ones it no longer does; it says when upstream's `apps/web/package.json` changed, and the webview's dependencies in `extension/package.json` follow it, at the versions the fork's lockfile resolves. A merge that leaves conflicts writes the pin to `t3/MERGING` instead of `UPSTREAM`; resolve the markers and run it again to record it. `pnpm vendor:check` fails while the copy is at another commit, holds a conflict marker, or differs from upstream in a file `t3/EDITS.md` does not list. Formatting and lint skip the copy; `pnpm typecheck` covers it as the entry reaches it.

## A web extension

The manifest declares only a `browser` entry, so there is no Node: no `node:` imports, no `process`, no child processes or raw sockets; the network is `fetch` and `WebSocket`. The bundle (`--platform=browser`) and the tsconfig (the `WebWorker` lib, and `types: ["vscode"]` keeping Node's types out) both fail on a Node import (`pult/decisions`, `web-extension`). A UX that needs Node is Anton's call (RFC 1: "the day a concrete UX needs Node, web goes"), not a workaround.

The bundle defines `globalThis.location` as `undefined`: Effect's HTTP client resolves every URL against `location`, which in a worker started from a `blob:` URL, as the extension host is, is no base URL, so every request would fail before it is sent. The define stands until Effect's `Url.baseUrl()` is fixed (`pult/effect-url-base-location`). The thread bundle is a page with a location, a separate build without the define.

A thread tab's page reaches the server only through the host (`pult/decisions`, `connection-owner`): its runtime's socket is a virtual one the host multiplexes onto the window's socket, and its `fetch` to the environment is performed by the host, whose origin a server admits where a webview's, which changes per webview, cannot be named.

## The two ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path or worktree string; your own agent process has this path in its argv, and this machine runs other VS Code windows and dev servers. Kill only a PID you captured at spawn.
2. **The live server.** Anton's running T3 Code Extensible, home `~/.t3`, hosts the fleet, you included. Test against a dev server on an isolated home (`docs/development.md`). Never attach a development build to the live server without asking, and never open `~/.t3/userdata` read-write.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Entry points.** A command shows in the command palette unless `menus.commandPalette` hides it; it may also belong in a view's title bar, its welcome content, a context menu or a keybinding.
- **Hosts.** Desktop VS Code and VS Code for the Web.
- **Contracts.** Anything crossing the wire is typed in the vendored `contracts`. The extension cannot change it; a new wire shape is a fork change (`../t3code-extensible`), offered upstream when it is generic.
- **Reverse states.** If you added a way in, add the way out and the way to see it: a connect has a disconnect and a visible connection state.
- **Connection modes.** Local and remote servers; one window per environment.
- **Docs.** Check whether the change makes existing guidance inaccurate before adding anything.

## Verifying

- `pnpm i` installs; `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm test` and `pnpm vendor:check` are the checks; `pnpm package` writes the VSIX to `release/`.
- Vitest for pure logic, next to the code as `*.test.ts`; no UI tests. Do not add tests that merely mirror the implementation. A test that needs a timeout or a sleep to pass is wrong.
- `pnpm test:web` is the headless load: `@vscode/test-web` opens VS Code for the Web in Playwright's headless Chromium on port 3917 (`PULT_TEST_WEB_PORT` moves it, for a second run beside another), runs `extension/test/load.ts` in the web worker extension host beside the extension, and fails unless the extension activates and registers its commands. The first run downloads VS Code into `extension/.vscode-test-web/`. Given a dev server's pairing link, it also connects and opens a thread tab, and can send a message from it (`docs/development.md`).
- A user-visible change gets one pass in a real VS Code, F5 (`.vscode/launch.json`), by the primary agent after integrating, with Anton's permission before any browser or computer use. Subagents do not launch their own.

## Documentation

Most code changes do not need a documentation change.

- `docs/` holds what is useless without the checkout. Designs, direction and decisions live in xaxis under `pult/`, since someone without the repo uses them too. Before adding a paragraph, ask what a maintainer would get wrong without it.
- An effort's design and plan live on its xaxis issue, not here. Do not commit research notes or agent scratch files.

## Code conventions

The track's design principles are xaxis `pult/taste`. In this repo's code:

- Inferred types over annotations. `any` is the enemy. Follow Effect's patterns where the vendored code uses it.
- Comments describe how a thing is used, and move when the code moves.
