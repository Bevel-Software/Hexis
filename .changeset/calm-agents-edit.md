---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

Let admins edit the connected-agent description inline on External agent access, place that section below connection setup, and hide its backing `mcp-description.md` control file from workspace navigation.

The workspace write route also accepts an `ifMatch` precondition, so a save composed from a stale snapshot is refused with a 409 instead of overwriting another admin's edit, and the file read route no longer reports an unreadable file as a missing one.
