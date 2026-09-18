---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

`access.md`, `roles.yaml`, `.bevelignore` and `AGENTS.md` can no longer be renamed, moved or dragged out of the folder the platform reads them from. Every surface refuses with one sentence — "<name> is a platform file and stays in its folder." — the move endpoint, the sidebar's drag and its Rename action, and the agent's `move_file` tool. The move confirmation's old warning ("moving it changes how the platform reads it") is gone: a move that breaks the workspace is not a choice to confirm.

What went wrong without this: a tester moved `access.md` and `.bevelignore` out of the repository root. A root with no `access.md` resolves write to default-deny for everyone, so the move that would have put the file back was the move the gate refused, and deleting the instance looked like the only way out.

So there is one exception, for that repair only. An Admin — the `Admin` role or the deployment owner — may move a file named `roles.yaml`, `.bevelignore` or `AGENTS.md` into the repository root, and a file named `access.md` into a folder that has none, even when the destination's own rules would refuse them the write. It is the same rescue that already lets an admin edit `access.md` and `roles.yaml`, and it is deliberately narrow: only an admin, only into the required location, only under the file's own name, and never taking a file OUT of the root — "move the root's `access.md` into a folder that has none" is how the root loses it in the first place, so it is refused like any other move. A non-admin never gets the exception, and the agent tools never get it at all. The claim travels to the lock gate as a claim; the access module decides whether it is true.

Ordinary files are untouched, and so is a nested `roles.yaml` or `AGENTS.md` — the platform reads those two at the repository root and nowhere else, so a nested file of either name is content and moves freely.
