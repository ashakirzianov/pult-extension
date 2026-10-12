# Edits to the copy

This directory is the fork's `apps/web` at the commit in `UPSTREAM`, as far as the thread bundle's entry (`../src/`) reaches it; `pnpm vendor:merge` keeps it so (`DECISIONS.md`, `thread-view-source`). What a thread tab needs from the app around the view lives in files of ours: `../src/` mounts upstream's components, and `../stubs.ts` replaces whole upstream modules. Editing a copied file is the exception, made when neither can do it; each edited file is listed here, one bullet with its reason (`` - `src/a.ts`: why ``), and the merge carries it through upstream's changes. `pnpm vendor:check` fails on a copied file that differs from upstream at `UPSTREAM` and is not listed, and on a listed file that does not differ.

None yet.
