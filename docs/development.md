# Running against a dev server

The extension runs no server, so testing it needs one, and never Anton's live server (`~/.t3`). Pult's dev runner starts one on an isolated home.

## Starting one

In a Pult worktree, `T3CODE_DEV_ALLOWED_ORIGINS=vscode-file://vscode-app vp run dev` starts a server against that worktree's `.t3`. The main checkout is no worktree and would use `~/.pult`, so add `--home-dir <dir>` there.

The variable is there because a dev server accepts cross-origin HTTP only from the origins it names, and desktop VS Code runs the extension from `vscode-file://vscode-app`, which fetches a WebSocket ticket over HTTP before it connects.

## Pairing

- **Desktop VS Code** pairs with the server port (the `[dev-runner]` line's `serverPort`) and a token. The pairing link names the web port, whose Vite answers preflights itself and admits only localhost origins.
- **VS Code for the Web** runs its extension host at a `v--<hash>.localhost` origin that changes with the browser profile: the web port admits it, and no fixed variable could name it, so the pairing link works as is.

## The headless load

`pnpm test:web` with `PULT_TEST_PAIRING_LINK` set, to a pairing link or `<server>/#token=<token>`, also connects to that server, waits for its projects, and disconnects. A session token from `t3 auth session issue` survives reruns. `PULT_TEST_RECONNECT=1` then also waits, while you restart the server, for the connection to drop and come back.
