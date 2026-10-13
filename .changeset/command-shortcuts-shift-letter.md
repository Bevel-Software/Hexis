---
'@bevel-software/platform-core-frontend': minor
---

The command menu's shortcuts are one key each, and "New page" is called "Create new page".

With the menu closed, C still creates a new page; ⇧I opens Invite (for admins), ⇧K goes to Knowledge and ⇧S to Skills & Tools. G then K and G then S no longer do anything. The keys run under the same guards as before — not in a field, a select or an editor, not under a modal dialog, not with Ctrl, ⌘ or Alt held, and not while the menu is open, where the shortcut letters type into the search — and C runs only without Shift, the Shift keys only with it. The menu draws each shortcut as one keycap of one width: "C", and "⇧I", "⇧K", "⇧S" on Apple devices or "Shift I", "Shift K", "Shift S" elsewhere; a screen reader hears "shortcut Shift K". Typing "new", "create" or "new page" finds Create new page. The Get set up list's "New page" button keeps its label.

For distributions: a command's `shortcut` (`AppRegistry.commandActions`) changes shape, from a list of keys to one letter with or without Shift — `{ key: 'o' }` or `{ key: 'o', shift: true }`. A shortcut that is not one letter, or that takes a key already bound, is dropped with its hint, and the console says why.

Migrating: key sequences are gone, so a sequence becomes one letter. Replace `shortcut: ['G', 'O']` with `shortcut: { key: 'o', shift: true }` (⇧O), or with `{ key: 'o' }` for a plain O. C, ⇧I, ⇧K and ⇧S are taken. A command left on the old list shape still appears in the menu and still runs from it, but it loses its key and its hint, and the console names the command and the shortcut it was given.
