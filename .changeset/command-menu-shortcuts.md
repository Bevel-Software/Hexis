---
'@bevel-software/platform-core-frontend': minor
---

Single-key shortcuts for the commonest commands: `C` makes a new page, `G` then `K` goes to Knowledge, `G` then `S` to Skills & Tools (the second key within a second of the first).

They are taken only when nobody could mean the key as text or as anything else: focus is not in a field, a select or an editor, no modifier is held, no modal dialog is up, and the command menu is shut. A shortcut for a command that is not on offer (no Knowledge app, say) lets the key through.

The menu shows each one on its command, drawn as keys and read out as "(shortcut G then K)". The hints and the bindings come from one table, `COMMAND_SHORTCUTS` in `modules/toolbar/commands/actions`, so a row never advertises a key that does nothing; `useCommandShortcuts` binds it, mounted once by the palette.
