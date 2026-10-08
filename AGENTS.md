# Pult extension

This repo is **Pult's VS Code extension**, step 1 of RFC 1, and a repo of the **Pult track**: see `TRACK.md`. The extension attaches to a running T3 Code server over its WebSocket and HTTP protocol, typed by the vendored packages, and ships as a VSIX. The server is not here: a server-side need goes to the fork (`../pult/DECISIONS.md`, `server-side-home`). The track's home is the Pult repo (`../pult`): its RFCs, its decisions and the web and desktop clients. Cross-track conventions live in `../axis/AGENTS.md`.

- Read `../pult/docs/pult/rfc-0.md` (human-written, never edited by agents) before anything else, then `../pult/docs/pult/rfc-1.md`, the current direction.
- `DECISIONS.md` holds this repo's rulings and `../pult/DECISIONS.md` the track's.
- Commits are small and semantically scoped, one logical unit each, with conventional titles. `origin` is `github.com/ashakirzianov/pult-extension`.
- Licence: upstream's MIT text stays.

## Review posture

**High-level.** Anton reviews direction, interfaces and module boundaries (the RFCs, `DECISIONS.md`, the seams with the server and the vendored packages), not implementation. Agents commit on their own and surface design deltas introduced during implementation rather than landing them silently. **Never push unless asked:** pushing is Anton's call while the GitHub repo is not created.

## Glossary

- **you** means the agent reading this file and changing the extension.
- **user** means Anton, using Pult to direct coding agents.
- **agent** means a coding agent run inside a T3 Code thread. Depending on context, that may include you.
- **environment** means one running server and the machine, filesystem, credentials and state it owns. The extension runs no server; it attaches to one.
- **project**, **thread**, **turn** are the server's: a workspace record rooted at a directory, the durable conversation for a project, one user-to-agent cycle.
- **T3 home** means the server's base data directory: `~/.t3` for the live server.

## Where code lives

- `extension/` - the extension: the manifest (`package.json`, whose `contributes` are the commands, the Activity Bar container and its views), `src/extension.ts` as the entry, `src/connection/` the window's connection (the environment catalog and the window binding, the HTTP probe, the vendored runtime's platform layer and the service over it), `media/`, and `test/load.ts`, the headless load. esbuild bundles it into `dist/web/extension.js`.
- `vendor/t3code/packages` - `contracts`, `client-runtime`, `shared`; `vendor/t3code/patches` - the fork's patches to the packages this repo installs, applied through `pnpm-workspace.yaml`, whose `catalog`, `overrides`, `packageExtensions` and `patchedDependencies` blocks `vendor.ts` writes from the fork's (never edit those blocks either). All of it is copied verbatim from T3 Code Extensible at the commit in `vendor/t3code/PIN`. Import `client-runtime` by subpath; it has no root export.
- `scripts/` - `vendor.ts` and its test, the vendoring; `checkout.ts`, which finds the fork's checkout; and `testWeb.ts`, the headless load's runner.
- `docs/` - standing notes and runbooks: `development.md`, running against a dev server.

**Never edit `vendor/`.** A bump is a new PIN, `pnpm vendor:sync`, `pnpm i`, and fixing what the types say; `pnpm vendor:check` fails on drift. The fork's checkout is `PULT_T3CODE_CHECKOUT` (environment or `.env`), by default `~/repos/t3code-extensible`. The PIN is Pult's: bump it here and in Pult together (`DECISIONS.md`, `extension-repo`).

## A web extension

The manifest declares only a `browser` entry, so there is no Node: no `node:` imports, no `process`, no child processes or raw sockets; the network is `fetch` and `WebSocket`. The bundle (`--platform=browser`) and the tsconfig (the `WebWorker` lib, and `types: ["vscode"]` keeping Node's types out) both fail on a Node import (`DECISIONS.md`, `web-extension`). A UX that needs Node is Anton's call (RFC 1: "the day a concrete UX needs Node, web goes"), not a workaround.

The bundle defines `globalThis.location` as `undefined`: Effect's HTTP client resolves every URL against `location`, which in a worker started from a `blob:` URL, as the extension host is, is no base URL, so every request would fail before it is sent. The define stands until Effect's `Url.baseUrl()` is fixed (`pult/effect-url-base-location`).

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
- `pnpm test:web` is the headless load: `@vscode/test-web` opens VS Code for the Web in Playwright's headless Chromium on port 3917, runs `extension/test/load.ts` in the web worker extension host beside the extension, and fails unless the extension activates and registers its commands. The first run downloads VS Code into `extension/.vscode-test-web/`. Given a dev server's pairing link, it also connects (`docs/development.md`).
- A user-visible change gets one pass in a real VS Code, F5 (`.vscode/launch.json`), by the primary agent after integrating, with Anton's permission before any browser or computer use. Subagents do not launch their own.

## Documentation

Most code changes do not need a documentation change.

- A `DECISIONS.md` entry takes the shape in `../axis/workflow/global-agents.md`. Before adding a paragraph, ask what a maintainer would get wrong without it.
- An effort's plan may sit beside its design as `docs/<effort>-tasks.md` while the effort runs; when the effort ends, both move to `archive/`. Do not commit research notes or agent scratch files.

## Taste

- Complexity belongs at the boundary. UI stays dumb; what the server can do deterministically, do not ask an agent to do.
- Inferred types over annotations. `any` is the enemy. Follow Effect's patterns where the vendored code uses it.
- Comments describe how a thing is used, and move when the code moves.
- No continuously repainting animations. Users notice a dropped frame, a lying spinner and a stale label.
- Do not preserve complexity because it already exists, and do not add machinery because it looks architecturally impressive. Fight scope creep. If a rule here fights the task, say so and get a human sign-off before breaking it.
