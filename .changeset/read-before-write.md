---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-shared': minor
---

You can only change what you can read. Nothing is created, changed, moved into or removed from a folder the person cannot read — on every branch, drafts included. On a shared branch this was already so, since a write grant carries read; on a draft, where anyone may propose anything, a proposal could be made into a folder its author could not see, where it vanished from them the moment it landed. The platform tried to keep such files visible with an automatic per-file read grant, which only markdown could carry, and warned before adding a file that could not carry one. Both are gone: the read check happens where every write is already checked, at the lock, so the explorer, uploads, archive extraction and every agent file tool refuse the same way, with a message that names the folder the person cannot read. Proposing is not offered for such a change either.

There are two exceptions. The first is a new folder directly under the knowledge, skills or plugins root. Anyone may start one, whatever the root's rules grant them, and the new folder's `access.md` is seeded with the creator's own read grant so what they put there is visible to them — the same way a new plugin is provisioned. A loose file directly at a root has no folder to carry that grant and is not excepted.

The second is the admin rescue: an Admin can always change the repository root's own files (`roles.yaml`, `access.md`, `groups.yaml`, and the agent guide — `AGENTS.md` unless the deployment named it otherwise), whatever the root's rules say, so a tree that grants nobody stays repairable from inside the app. That floor covers only the root's own files — an admin excluded from reading a subfolder cannot change it either. (An explicit `deny read` naming a person, placed under a folder that grants them write higher up, is now read as it looks: no read, so no changes there either.)

The agent guide (`AGENTS.md`, or the name the deployment gave it) states the rule and both exceptions.
