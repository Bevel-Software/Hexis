---
'@bevel-software/platform-core-backend': patch
---

AGENTS.md becomes the one source of truth, and the platform keeps it
current. The template's per-folder README.md files are gone (their
content lives in AGENTS.md), and the scaffolding top-up now REPLACES a
stale AGENTS.md with the packaged template's copy on every fresh clone
of a protected branch — in practice, every server restart. The file's
own header states the contract: edits there are overwritten; your own
conventions belong in files of your own. Line-ending differences alone
never trigger a refresh commit.
