---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

Let admins edit the connected-agent description inline on External agent access, place that section below connection setup, and hide its backing `mcp-description.md` control file from workspace navigation.

The workspace write route also accepts an `ifMatch` precondition, so a save composed from a stale snapshot is refused with a 409 instead of overwriting another admin's edit, and the file read route no longer reports an unreadable file as a missing one. `platform-shared` gains `canonicalRelativePath`, the one file identity the read, write, delete and move verbs coordinate on, and `agent-preamble.ts`, where the preamble's file name, caps and comment rule now live for both the composer and the editor. A precondition is answered only to a caller who may read the file.
