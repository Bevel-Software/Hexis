---
'@bevel-software/platform-core-backend': patch
---

"Remove from the whole workspace" works from a folder's Manage access dialog. The revoke route's `remove-from-parent` mode now reads an empty `ancestor` (what the dialog sends for the root `access.md`) as the workspace root, as it already read the kbDir name: the person is removed from the root `access.md`, and the Admin role is refused with the `admin-root-write` message, the root left unchanged. A body with no `ancestor` at all is still refused, and its error no longer names the field: "Choose the folder to remove this access from, then try again."
