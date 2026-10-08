# Pult for VS Code

Pult is a client for T3 Code, and this is Pult in VS Code: an extension that attaches to a running T3 Code server and brings its agent threads into the editor, beside the files and diffs the agents work on. It is a web extension, so the same build runs in desktop VS Code and in VS Code for the Web, and it ships as a VSIX.

`pnpm i` installs, `pnpm build` bundles the extension, F5 in VS Code opens an Extension Development Host with it, and `pnpm package` writes the VSIX to `release/`, which `code --install-extension` installs. The T3 Code protocol packages in `vendor/` are copied verbatim from T3 Code Extensible at a pinned commit (see `AGENTS.md` at `github.com/ashakirzianov/pult-extension`). MIT licensed, with upstream's licence text.
