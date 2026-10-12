# Edits to the copy

This directory is the fork's `apps/web` at the commit in `UPSTREAM`, as far as the thread bundle's entry (`../src/`) reaches it; `pnpm vendor:merge` keeps it so (`DECISIONS.md`, `thread-view-source`). What a thread tab needs from the app around the view lives in files of ours: `../src/` mounts upstream's components, and `../stubs.ts` replaces whole upstream modules. Editing a copied file is the exception, made when neither can do it; each edit is listed here with its reason, and the merge carries it through upstream's changes.

None yet.
