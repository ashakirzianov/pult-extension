# Pult extension

This repo is **Pult's VS Code extension**, step 1 of RFC 1, and a repo of the **Pult track**: see `TRACK.md`. The track's home is the Pult repo (`../pult`): its RFCs, its decisions and the web and desktop clients. Cross-track conventions live in `../axis/AGENTS.md`.

- Read `../pult/docs/pult/rfc-0.md` (human-written, never edited by agents) before anything else, then `../pult/docs/pult/rfc-1.md`, the current direction. `DECISIONS.md` holds this repo's rulings and `../pult/DECISIONS.md` the track's; `AGENTS.md` below is the codebase conventions.
- **Shape.** `extension/` is the extension (VS Code id `pult.pult`), `vendor/t3code/` the protocol packages `contracts`, `client-runtime` and `shared`, plus the fork's patches they rely on, copied verbatim from T3 Code Extensible at the commit in `vendor/t3code/PIN`, which is Pult's (`extension-repo`). `scripts/` is the vendoring.
- **Never edit `vendor/`.** A bump is a new PIN, `pnpm vendor:sync`, `pnpm i`, and fixing what the types say; `pnpm vendor:check` fails on drift. The checkout is `PULT_T3CODE_CHECKOUT` (environment or `.env`), by default `~/repos/t3code-extensible`. Bump the PIN here and in Pult together.
- **No server in this repo.** The extension attaches to a running T3 Code server; a server-side need goes to the fork (`../pult/DECISIONS.md`, `server-side-home`).
- Commits: small and semantically scoped, one logical unit each, with conventional titles. **Never push unless asked.** `origin` is `github.com/ashakirzianov/pult-extension`.
- Issues live in xaxis as `pult/<slug>` with the label `pult-extension` (see `TRACK.md` frontmatter and the global conventions in `~/.claude/CLAUDE.md`). A standing note belongs in `docs/`, never the tracker.
- Licence: upstream's MIT text stays.

@AGENTS.md
