---
'@bevel-software/platform-core-frontend': minor
---

The toolbar's search box runs commands too. It reads "Search or run a command", and the palette it opens (Ctrl+K, ⌘K on a Mac) lists an **Actions** group first, above Pages and Skills & tools.

- With nothing typed it suggests a few: New page, Invite people (admins), Connect your agent (while that onboarding is open) and a way to the other app. A query ranks every offered command by its label and its keywords, the same way pages are ranked (`team` finds Invite people).
- Core's commands: **New page** (an `Untitled.md`, or the next free `Untitled N.md`, in the Knowledge folder, opened in the editor), **Edit this page** (only while the page on screen could be opened for editing), **Invite people** (admins), **Connect your agent**, **Go to …** for each app in the switcher, and **Settings: …** for each row the profile menu shows — the admin rows for admins only. A dialog row from the registry is not offered (its dialog belongs to the profile menu), nor is a row whose label is not plain text.
- Choosing a command closes the palette first. One that fails opens it again with the reason.
- A row can show the keys that run it, drawn as keys and read out as "shortcut G then K".

New:

- `AppRegistry.commandActions?: CommandAction[]` — commands a distribution adds, listed after core's. A command is `{ id, label, keywords?, group?, shortcut?, icon?, visible(ctx), run(ctx) }`; the context carries navigation, the admin verdict, the active app, the open file, the invite dialog and New page. A reused id is dropped and a `visible` that throws costs only its own row.
- `useCreatePage()` (`modules/workspace/hooks/useCreatePage`) — the Get set up list's New page, shared: an exclusive create that moves on to the next name on a 409 and opens the page in edit mode. The list behaves as before.
- `openWorkspacePath(path, { replace: true })` replaces the history entry instead of adding one.
- The file viewer publishes which page an Edit click would open for editing (`workspace/state/editable-page`), by the same conditions its Edit button follows.
