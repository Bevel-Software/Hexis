---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-shared': minor
---

The knowledge base's conventions file is now `AGENTS.md` rather than `CLAUDE.md`.

It is the same file doing the same job — the KB author's house rules, which
every agent is told to read before its first touch of a workspace. The name is
what changed, and it changed because `AGENTS.md` is the cross-tool convention:
Claude Code, Cursor and others pick it up from a repo root on their own, so the
file keeps working for an agent that never sees our tool descriptions.

The filename now lives in one place — `KB_CONVENTIONS_FILE` in
`@bevel-software/platform-shared` — read by the seed template, the scaffolding
top-up, and the note appended to every workspace tool description. Those three
spelled it out separately before and could drift.

**Existing knowledge bases are migrated, not left behind.** The first time a
branch is loaded after this release, the scaffolding top-up `git mv`s a
pre-rename `CLAUDE.md` to `AGENTS.md` and commits it. The file is MOVED, so the
author's own conventions survive and history follows the rename — the top-up
would otherwise see `AGENTS.md` missing and drop a pristine template copy next
to it, leaving agents two conventions files to choose between. The
`.bevelignore` line naming the old file is retargeted in the same commit, so
the file stays hidden from the tree instead of appearing in it for the first
time.

The migration declines to touch anything it cannot move safely: a KB that
already has an `AGENTS.md` keeps both files untouched, and a branch already
migrated makes no second commit.
