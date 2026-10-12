# Running against a dev server

The extension runs no server, so testing it needs one, and never Anton's live server (`~/.t3`). Pult's dev runner starts one on an isolated home.

## Starting one

In a Pult checkout, the main one or a worktree, `T3CODE_DEV_ALLOWED_ORIGINS=vscode-file://vscode-app vp run dev` starts a server against that checkout's own `.t3`.

The variable is there because a dev server accepts cross-origin HTTP only from the origins it names, and desktop VS Code runs the extension from `vscode-file://vscode-app`, which fetches a WebSocket ticket over HTTP before it connects.

## Pairing

The pairing link names the web port, whose Vite answers preflights itself. Both clients pair with it as printed:

- **Desktop VS Code**: Vite admits the origins the variable names.
- **VS Code for the Web** runs its extension host at a `v--<hash>.localhost` origin that changes with the browser profile: Vite admits any localhost origin, and no fixed variable could name it.

## The headless load

`pnpm test:web` with `PULT_TEST_PAIRING_LINK` set, to a pairing link or `<server>/#token=<token>`, also connects to that server, waits for its projects, and disconnects. A session token from `t3 auth session issue` survives reruns. `PULT_TEST_RECONNECT=1` then also waits, while you restart the server, for the connection to drop and come back.
