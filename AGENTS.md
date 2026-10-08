# Pult extension codebase conventions

The extension attaches to a running T3 Code server over its WebSocket and HTTP protocol, typed by the vendored packages, and ships as a VSIX. These conventions are adapted from the Pult repo's `AGENTS.md`, kept where they apply to an extension.

## Glossary

- **you** means the agent reading this file and changing the extension.
- **user** means Anton, using Pult to direct coding agents.
- **agent** means a coding agent run inside a T3 Code thread. Depending on context, that may include you.
- **environment** means one running server and the machine, filesystem, credentials and state it owns. The extension runs no server; it attaches to one.
- **project**, **thread**, **turn** are the server's: a workspace record rooted at a directory, the durable conversation for a project, one user-to-agent cycle.
- **T3 home** means the server's base data directory: `~/.t3` for the live server.

## Where code lives

- `extension/` - the extension: the manifest (`package.json`, whose `contributes` are the commands, the Activity Bar container and its views), `src/extension.ts` as the entry, `src/connection/` the window's connection (the environment catalog and the window binding, the HTTP probe, the vendored runtime's platform layer and the service over it), `media/`, and `test/load.ts`, the headless load. esbuild bundles it into `dist/web/extension.js`.
- `vendor/t3code/packages` - `contracts`, `client-runtime`, `shared`; `vendor/t3code/patches` - the fork's patches to the packages this repo installs, applied through `pnpm-workspace.yaml`, whose `catalog`, `overrides`, `packageExtensions` and `patchedDependencies` blocks `vendor.ts` writes from the fork's. Read them, never edit them. Import `client-runtime` by subpath; it has no root export.
- `scripts/` - `vendor.ts` and its test, and `testWeb.ts`, the headless load's runner.
- `docs/` - standing notes and runbooks: `development.md`, running against a dev server.

## A web extension

The manifest declares only a `browser` entry, so desktop VS Code runs the extension in its web worker extension host, and the same bundle runs in VS Code for the Web. There is no Node: no `node:` imports, no `process`, no child processes or raw sockets; the network is `fetch` and `WebSocket`. The bundle targets `--platform=browser` and the tsconfig carries only the `WebWorker` lib, so a Node import fails both. This is why SSH and Tailscale connections, which the Pult desktop has, are not here. The bundle defines `globalThis.location` as `undefined`: Effect's HTTP client resolves every URL against `location`, which in a worker started from a `blob:` URL, as the extension host is, is no base URL, so every request would fail before it is sent. The lasting fix is narrower and belongs in Effect's `Url.baseUrl()`, which should ignore a `location` whose protocol is not http(s); it can go into the fork's Effect patch and be offered upstream, and until then the define stands. A UX that needs Node is Anton's call (RFC 1: "the day a concrete UX needs Node, web goes"), not a workaround.

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

Most code changes do not need a documentation change. `DECISIONS.md` holds the rulings (see `~/.claude/CLAUDE.md` for the entry shape); before adding a paragraph, ask what a maintainer would get wrong without it. Do not commit implementation plans, research notes or agent scratch files.

## Taste

- Complexity belongs at the boundary. UI stays dumb; what the server can do deterministically, do not ask an agent to do.
- Inferred types over annotations. `any` is the enemy. Follow Effect's patterns where the vendored code uses it.
- Comments describe how a thing is used, and move when the code moves.
- No continuously repainting animations. Users notice a dropped frame, a lying spinner and a stale label.
- Do not preserve complexity because it already exists, and do not add machinery because it looks architecturally impressive. Fight scope creep. If a rule here fights the task, say so and get a human sign-off before breaking it.
