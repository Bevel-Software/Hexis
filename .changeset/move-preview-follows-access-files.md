---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

The preview of a move or a copy judges access as it will be afterwards, including the access files that travel with the folder.

A dry run of `move_file` used to read `access.after` off the destination as it stands on disk — where the folder being moved, and the `access.md` files inside it, are not yet. So renaming a folder that names you owner in its own `access.md` warned that you would lose owner access, and after the move you were still owner. A warning that is wrong is a warning people learn to click through.

`access.after` is now the caller's access at the destination as it will be once the operation has landed: every `access.md` at or under the source is counted at the path it lands on, rules the folder inherited from its old parent are left behind, and rules it will inherit from its new parent apply. `accessChanges` — and so whether the move asks for `confirm: true` — follows from that, and a move that costs nothing no longer asks. A folder with no `access.md` of its own, and a single file, preview exactly as before. What the move itself does is unchanged.

`copy_file` now takes `dryRun: true` and answers the same impact — `{ src, dest, kind, descendants, access: { before, after }, accessChanges, allowed, reason? }` — with `after` counting the copied access files at the destination. A folder source is reported as the refusal it is (`copy_file` copies one file), and the call itself now refuses a folder with that same sentence and a 400 instead of letting the filesystem's error escape.

The app's move dialog asks about a dragged FOLDER as well as a file, and names what the move really costs; it used to ask nothing at all for a folder.

For integrators, `IAccessControl` gains `previewAccessAfterRelocation(workspaceId, userEmail, fromPath, toPath, opts?)`, answering the caller's own `{ read, write, download, owner }` at `toPath` as they will be once `fromPath` has been moved (or, with `{ sourceRemains: true }`, copied) there. It is a PREVIEW: it describes a tree that does not exist and must never gate an operation. `prospectiveHolders` no longer refuses a folder source with a 400 — it answers one, over the `access.md` files the folder carries — so `GET /api/workspace/:id/access/prospective` accepts a folder `from`.
