---
'@bevel-software/platform-core-frontend': minor
---

Single-key shortcuts for the commonest commands: `C` makes a new page, `G` then `K` goes to Knowledge, `G` then `S` to Skills & Tools (the second key within a second of the first).

They are taken only when nobody could mean the key as text or as anything else: focus is not in a field, a select or an editor, no modifier is held, no modal dialog is up, and the command menu is shut. A shortcut for a command that is not on offer (no Knowledge app, say) lets the key through.

The menu shows each one on its command, drawn as keys and read out as "(shortcut G then K)". A command's `shortcut` field is both the hint and the binding: core's come from one table, `COMMAND_SHORTCUTS` in `modules/toolbar/commands/actions`, and a command a distribution adds through `AppRegistry.commandActions` is bound under the same guards when it sets one, so a row never advertises a key that does nothing. Keys that would collide with ones already bound (the same keys, or a sequence one of them begins) are dropped from the command at merge time, hint included, with a console error. `useCommandShortcuts` binds them, mounted once by the palette.
