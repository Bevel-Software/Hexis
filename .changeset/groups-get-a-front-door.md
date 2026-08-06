---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Skills are created in place, and groups get a front door.

The add-skill dialogs' "open the folder in the workspace" link is replaced by
a door that creates the skill: name it, and an empty `SKILL.md` (frontmatter
fence, empty description) is written and opened. Writing into a group you
manage lands directly; anyone else's creation rides the existing propose flow
and arrives as a change request. The write is an exclusive create end to end
(fs flag `wx` behind a new `ifAbsent` option), so a stale catalog or a
concurrent creator gets a 409 instead of silently emptying an existing skill.

Group creation moves off the generic write path onto a dedicated provisioning
endpoint (`POST /api/groups`) — the one privileged door for claiming a name
under `Groups/`. The server validates the name, writes the folder's
`access.md` (readable by everyone so the group can be listed and joined; run
by its creator) and commits it before answering. The write gate's new-folder
carve-out is gone: the gate is uniformly strict again.

Personal skills now live in a real place: `Groups/personal-<user-id>/`,
ensured lazily through the same endpoint on first use, private by default
(its access.md names only its owner). Skills created there are ordinary
writes under ordinary rules — no permission special-cases anywhere — and
personal folders never appear in group listings.
